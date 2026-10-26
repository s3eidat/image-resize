/* Image Resize — crop + high-quality resize with <canvas>, entirely on this device. */
(function () {
  "use strict";
  const $ = S3.$, $$ = S3.$$;
  const MAX_SIDE = 16384, MAX_AREA = 40e6, MIN = 8;
  const MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp" };
  const EXT = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" };
  const saved = S3.store("resize") || {};
  const opts = Object.assign({ mode: "px", w: 1080, h: "", lock: true, anchor: "w", pct: 50, ratio: "free", format: "keep", quality: 90, preset: "" }, saved);
  let items = [], sel = null, nextId = 1;

  // ---------- geometry (pure) ----------
  const r1 = n => Math.max(1, Math.round(n));
  function exact(o) { return o.mode === "px" && !o.lock && +o.w > 0 && +o.h > 0; }
  // Crop ratio in force for an image: exact W×H output forces W:H so nothing is ever stretched.
  function ratioFor(o, iw, ih) {
    if (exact(o)) return +o.w / +o.h;
    if (o.ratio === "free") return null;
    if (o.ratio === "orig") return iw / ih;
    return +o.ratio;
  }
  function defaultCrop(iw, ih, ratio) {
    if (!ratio) return { x: 0, y: 0, w: iw, h: ih };
    let w = iw, h = iw / ratio;
    if (h > ih) { h = ih; w = ih * ratio; }
    w = Math.round(w); h = Math.round(h);
    return { x: Math.round((iw - w) / 2), y: Math.round((ih - h) / 2), w, h };
  }
  function outSize(cw, ch, o) {
    if (o.mode === "pct") return { w: r1(cw * o.pct / 100), h: r1(ch * o.pct / 100) };
    const W = +o.w || 0, H = +o.h || 0;
    if (exact(o)) return { w: W, h: H };
    if (H && (o.anchor === "h" || !W)) return { w: r1(H * cw / ch), h: H };
    if (W) return { w: W, h: r1(W * ch / cw) };
    return { w: cw, h: ch };
  }
  // Drag a corner: the opposite corner stays put, the box stays inside the image and keeps its ratio.
  function dragCorner(c, corner, px, py, ratio, iw, ih) {
    const dx = corner.indexOf("e") >= 0 ? 1 : -1, dy = corner.indexOf("s") >= 0 ? 1 : -1;
    const ax = dx > 0 ? c.x : c.x + c.w, ay = dy > 0 ? c.y : c.y + c.h;
    const maxW = dx > 0 ? iw - ax : ax, maxH = dy > 0 ? ih - ay : ay;
    let w = Math.min(Math.max(MIN, (px - ax) * dx), maxW), h = Math.min(Math.max(MIN, (py - ay) * dy), maxH);
    if (ratio) { if (w / h > ratio) w = h * ratio; else h = w / ratio; }
    w = Math.round(w); h = Math.round(h);
    return { x: dx > 0 ? ax : ax - w, y: dy > 0 ? ay : ay - h, w, h };
  }
  function moveCrop(c, x, y, iw, ih) {
    return { x: Math.round(Math.min(Math.max(0, x), iw - c.w)), y: Math.round(Math.min(Math.max(0, y), ih - c.h)), w: c.w, h: c.h };
  }

  // ---------- rendering ----------
  function canvas(w, h) { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; }
  // Step-down: halve the crop region repeatedly, then one final smooth draw. Never copies the full-size image.
  function resample(src, c, tw, th, bg) {
    let cur = src, sx = c.x, sy = c.y, sw = c.w, sh = c.h;
    while (sw / 2 >= tw && sh / 2 >= th) {
      const n = canvas(Math.round(sw / 2), Math.round(sh / 2)), x = n.getContext("2d");
      x.imageSmoothingQuality = "high"; x.drawImage(cur, sx, sy, sw, sh, 0, 0, n.width, n.height);
      cur = n; sx = 0; sy = 0; sw = n.width; sh = n.height;
    }
    const out = canvas(tw, th), x = out.getContext("2d");
    if (bg) { x.fillStyle = bg; x.fillRect(0, 0, tw, th); }
    x.imageSmoothingQuality = "high"; x.drawImage(cur, sx, sy, sw, sh, 0, 0, tw, th);
    return out;
  }
  function outType(file, o) {
    if (o.format !== "keep") return MIME[o.format];
    return EXT[file.type] ? file.type : "image/png";
  }
  async function render(img, file, crop, o) {
    const s = outSize(crop.w, crop.h, o);
    if (s.w > MAX_SIDE || s.h > MAX_SIDE || s.w * s.h > MAX_AREA) throw new Error("Output " + s.w + "×" + s.h + " is too large for a browser canvas");
    const type = outType(file, o);
    const c = resample(img, crop, s.w, s.h, type === "image/jpeg" ? "#ffffff" : null);
    const blob = await new Promise(res => c.toBlob(res, type, o.quality / 100));
    if (!blob) throw new Error("The browser could not encode this image");
    return { blob, type, w: s.w, h: s.h };
  }
  function loadImage(blob) {
    const url = URL.createObjectURL(blob), img = new Image();
    img.src = url;
    return img.decode().then(() => { if (!img.naturalWidth) throw 0; img._url = url; return img; })
      .catch(() => { URL.revokeObjectURL(url); throw new Error("Can't read " + (blob.name || "this image")); });
  }
  function outName(it, r) { return it.file.name.replace(/\.[^.]+$/, "") + "-" + r.w + "x" + r.h + "." + EXT[r.type]; }

  // ---------- UI ----------
  const pic = $("#pic"), box = $("#box"), stageIn = $("#stageIn");
  function seg(el, value, onPick) {
    $$("button", el).forEach(b => {
      b.setAttribute("aria-pressed", String(b.dataset.v === String(value)));
      b.addEventListener("click", () => { $$("button", el).forEach(x => x.setAttribute("aria-pressed", String(x === b))); onPick(b.dataset.v); });
    });
  }
  function save() { S3.store("resize", opts); }
  function cropOf(it) {
    if (!it.crop) it.crop = defaultCrop(it.img.naturalWidth, it.img.naturalHeight, ratioFor(opts, it.img.naturalWidth, it.img.naturalHeight));
    return it.crop;
  }
  function resetCrops() { items.forEach(it => { it.crop = null; }); }

  async function addFiles(files) {
    for (const f of files) {
      try {
        const it = { id: nextId++, file: f, img: await loadImage(f) };
        items.push(it);
        it.el = S3.h("li", { "class": "rz-item", tabindex: "0" });
        $("#list").appendChild(it.el);
        if (!sel) sel = it;
      } catch (e) { S3.toast(e.message, "error"); }
    }
    update();
  }
  function update() {
    save();
    const has = items.length > 0;
    $("#empty").hidden = has; $("#stage").hidden = !has; $("#info").hidden = !has; $("#zip").disabled = !has;
    $("#zipLbl").textContent = items.length > 1 ? "Download all " + items.length + " (.zip)" : "Download";
    $("#pxBox").hidden = opts.mode !== "px"; $("#pctBox").hidden = opts.mode !== "pct";
    $("#lock").setAttribute("aria-pressed", String(opts.lock));
    $("#lockNote").textContent = opts.mode !== "px" ? "" : exact(opts) ? "Exact size: the crop box keeps " + opts.w + "×" + opts.h + " so nothing is stretched." : "Aspect ratio kept from the crop.";
    const forced = exact(opts);
    $$("#ratio button").forEach(b => { b.disabled = forced; });
    $("#ratioNote").hidden = !forced;
    $("#ratioNote").textContent = forced ? "Crop ratio follows the exact output size (" + opts.w + "×" + opts.h + "). Turn on the lock for free cropping." : "";
    // Show the computed other side for the selected image.
    if (sel && opts.mode === "px" && opts.lock) {
      const c = cropOf(sel), s = outSize(c.w, c.h, opts);
      if (opts.anchor === "h" && opts.h) $("#w").placeholder = s.w; else $("#h").placeholder = s.h;
    }
    items.forEach(it => {
      const c = cropOf(it), s = outSize(c.w, c.h, opts);
      it.el.classList.toggle("is-sel", it === sel);
      it.el.innerHTML = '<img alt="" src="' + it.img._url + '"><div><b title="' + S3.esc(it.file.name) + '">' + S3.esc(it.file.name) + "</b>" +
        it.img.naturalWidth + "×" + it.img.naturalHeight + " → " + s.w + "×" + s.h + "</div>" +
        '<button class="btn ghost small icon" data-rm aria-label="Remove ' + S3.esc(it.file.name) + '"><svg class="i"><use href="#i-x"/></svg></button>';
    });
    if (sel) {
      if (pic.src !== sel.img._url) pic.src = sel.img._url;
      drawBox();
    }
  }
  function drawBox() {
    if (!sel) return;
    const c = cropOf(sel), iw = sel.img.naturalWidth, ih = sel.img.naturalHeight, s = outSize(c.w, c.h, opts);
    box.style.left = c.x / iw * 100 + "%"; box.style.top = c.y / ih * 100 + "%";
    box.style.width = c.w / iw * 100 + "%"; box.style.height = c.h / ih * 100 + "%";
    $("#cropInfo").textContent = "Crop " + c.w + "×" + c.h;
    $("#outInfo").textContent = "Output " + s.w + "×" + s.h;
    box.setAttribute("aria-valuetext", "Crop " + c.w + " by " + c.h + " at " + c.x + ", " + c.y);
  }

  // crop dragging
  let drag = null;
  function natural(e) {
    const r = stageIn.getBoundingClientRect(), k = sel.img.naturalWidth / r.width;
    return { x: Math.min(Math.max(0, (e.clientX - r.left) * k), sel.img.naturalWidth), y: Math.min(Math.max(0, (e.clientY - r.top) * k), sel.img.naturalHeight) };
  }
  stageIn.addEventListener("pointerdown", e => {
    if (!sel || !e.target.closest("#box")) return;
    const h = e.target.closest(".rz-h");
    drag = { mode: h ? h.dataset.h : "move", p0: natural(e), c0: Object.assign({}, cropOf(sel)) };
    stageIn.setPointerCapture(e.pointerId); e.preventDefault();
  });
  stageIn.addEventListener("pointermove", e => {
    if (!drag) return;
    const p = natural(e), iw = sel.img.naturalWidth, ih = sel.img.naturalHeight, c0 = drag.c0;
    sel.crop = drag.mode === "move" ? moveCrop(c0, c0.x + p.x - drag.p0.x, c0.y + p.y - drag.p0.y, iw, ih)
      : dragCorner(c0, drag.mode, p.x, p.y, ratioFor(opts, iw, ih), iw, ih);
    drawBox();
  });
  const endDrag = () => { if (drag) { drag = null; update(); } };
  stageIn.addEventListener("pointerup", endDrag); stageIn.addEventListener("pointercancel", endDrag);
  box.addEventListener("keydown", e => {
    const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (!d || !sel) return;
    e.preventDefault();
    const c = cropOf(sel), iw = sel.img.naturalWidth, ih = sel.img.naturalHeight, step = Math.max(1, Math.round(iw / 100));
    sel.crop = e.shiftKey ? dragCorner(c, "se", c.x + c.w + d[0] * step, c.y + c.h + d[1] * step, ratioFor(opts, iw, ih), iw, ih)
      : moveCrop(c, c.x + d[0] * step, c.y + d[1] * step, iw, ih);
    update();
  });

  $("#list").addEventListener("click", e => {
    const li = e.target.closest(".rz-item"), it = items.filter(x => x.el === li)[0];
    if (!it) return;
    if (e.target.closest("[data-rm]")) {
      items = items.filter(x => x !== it); li.remove(); URL.revokeObjectURL(it.img._url);
      if (sel === it) sel = items[0] || null;
    } else sel = it;
    update();
  });
  $("#list").addEventListener("keydown", e => { if (e.key === "Enter" && e.target.classList.contains("rz-item")) e.target.click(); });

  // settings
  const wIn = $("#w"), hIn = $("#h");
  function showDims() { wIn.value = opts.w || ""; hIn.value = opts.h || ""; }
  function clampDim(v) { v = Math.round(+v); return v > 0 ? Math.min(v, MAX_SIDE) : ""; }
  wIn.addEventListener("input", () => { opts.w = clampDim(wIn.value); opts.anchor = "w"; if (opts.lock) { opts.h = ""; hIn.value = ""; } opts.preset = ""; $("#preset").value = ""; resetCrops(); update(); });
  hIn.addEventListener("input", () => { opts.h = clampDim(hIn.value); opts.anchor = "h"; if (opts.lock) { opts.w = ""; wIn.value = ""; } opts.preset = ""; $("#preset").value = ""; resetCrops(); update(); });
  $("#lock").addEventListener("click", () => {
    opts.lock = !opts.lock;
    if (!opts.lock && sel) { const c = cropOf(sel), s = outSize(c.w, c.h, Object.assign({}, opts, { lock: true })); opts.w = s.w; opts.h = s.h; showDims(); }
    if (opts.lock) { if (opts.anchor === "h") opts.w = ""; else opts.h = ""; showDims(); }
    resetCrops(); update();
  });
  $("#preset").addEventListener("change", e => {
    opts.preset = e.target.value;
    if (opts.preset) {
      const p = opts.preset.split("x"); opts.w = +p[0]; opts.h = +p[1]; opts.lock = false; opts.mode = "px";
      $$("#mode button").forEach(b => b.setAttribute("aria-pressed", String(b.dataset.v === "px")));
      showDims();
    }
    resetCrops(); update();
  });
  seg($("#mode"), opts.mode, v => { opts.mode = v; resetCrops(); update(); });
  seg($("#ratio"), opts.ratio, v => { opts.ratio = v; resetCrops(); update(); });
  const pct = $("#pct");
  function setPct(v) { opts.pct = v; pct.value = v; $("#pv").textContent = v + "%"; update(); }
  pct.addEventListener("input", () => setPct(+pct.value));
  seg($("#pctQuick"), "", v => setPct(+v));
  $("#reset").addEventListener("click", () => { if (sel) { sel.crop = null; update(); } });
  $("#format").value = opts.format;
  $("#format").addEventListener("change", e => { opts.format = e.target.value; save(); });
  const q = $("#quality");
  q.value = opts.quality; $("#qv").textContent = opts.quality + "%";
  q.addEventListener("input", () => { opts.quality = +q.value; $("#qv").textContent = q.value + "%"; save(); });
  $("#preset").value = opts.preset; pct.value = opts.pct; $("#pv").textContent = opts.pct + "%"; showDims();

  async function downloadOne(it) {
    const r = await render(it.img, it.file, cropOf(it), opts);
    S3.download(r.blob, outName(it, r)); S3.done();
  }
  $("#one").addEventListener("click", () => { if (sel) downloadOne(sel).catch(e => S3.toast(e.message, "error")); });
  $("#zip").addEventListener("click", async () => {
    const btn = $("#zip");
    if (items.length === 1) return downloadOne(items[0]).catch(e => S3.toast(e.message, "error"));
    btn.disabled = true;
    try {
      const files = [], used = {};
      for (const it of items) {
        $("#zipLbl").textContent = "Resizing " + (files.length + 1) + " / " + items.length + "…";
        const r = await render(it.img, it.file, cropOf(it), opts);
        let n = outName(it, r), i = 2; const base = n;
        while (used[n]) n = base.replace(/(\.[^.]+)$/, "-" + (i++) + "$1");
        used[n] = 1;
        files.push({ name: n, data: new Uint8Array(await r.blob.arrayBuffer()) });
      }
      S3.download(S3.zip(files), "resized-images.zip"); S3.done();
    } catch (e) { S3.toast(e.message, "error"); }
    btn.disabled = false; update();
  });
  S3.drop($("#drop"), addFiles, { accept: "image/*", multiple: true });
  document.addEventListener("paste", e => {
    const fs = Array.prototype.slice.call((e.clipboardData && e.clipboardData.files) || []).filter(f => /^image\//.test(f.type));
    if (fs.length) { e.preventDefault(); addFiles(fs); }
  });
  update();

  // ---------- sample (drawn locally) ----------
  function sample(w, h) {
    const c = canvas(w, h), x = c.getContext("2d");
    const sky = x.createLinearGradient(0, 0, 0, h); sky.addColorStop(0, "#0f3a5f"); sky.addColorStop(0.6, "#3dd6d0"); sky.addColorStop(1, "#f5e6b8");
    x.fillStyle = sky; x.fillRect(0, 0, w, h);
    x.fillStyle = "#fff6d5"; x.beginPath(); x.arc(w * 0.3, h * 0.3, h * 0.09, 0, Math.PI * 2); x.fill();
    [["#1d6b73", 0.7, 4], ["#0f4048", 0.82, 9]].forEach((m, i) => {
      x.fillStyle = m[0]; x.beginPath(); x.moveTo(0, h);
      for (let k = 0; k <= 80; k++) { const px = w * k / 80; x.lineTo(px, h * m[1] - Math.abs(Math.sin(px / w * m[2] + i * 2)) * h * 0.17); }
      x.lineTo(w, h); x.fill();
    });
    return c;
  }
  async function sampleFile(name, w, h) { const b = await new Promise(r => sample(w, h).toBlob(r, "image/jpeg", 0.9)); return new File([b], name, { type: "image/jpeg" }); }

  window.S3_DEMO = async function () {
    await addFiles([await sampleFile("lake-view.jpg", 2400, 1600), await sampleFile("coast.jpg", 1800, 1200)]);
    const p = $("#preset"); p.value = "1080x1080"; p.dispatchEvent(new Event("change"));
    sel.crop = moveCrop(cropOf(sel), 300, 0, 2400, 1600); update();
  };

  window.S3_SELFTEST = async function () {
    const base = { mode: "px", w: "", h: "", lock: true, anchor: "w", pct: 50, ratio: "free" };
    const t = (o, cw, ch) => { const s = outSize(cw, ch, Object.assign({}, base, o)); return s.w + "x" + s.h; };
    const g = [
      t({ mode: "pct", pct: 50 }, 4000, 3000) === "2000x1500",
      t({ w: 1080 }, 1600, 900) === "1080x608",
      t({ h: 500, anchor: "h" }, 1600, 900) === "889x500",
      t({ w: 1080, h: 1920, lock: false }, 506, 900) === "1080x1920",
      JSON.stringify(defaultCrop(1600, 900, ratioFor(Object.assign({}, base, { w: 1080, h: 1920, lock: false }), 1600, 900))) === '{"x":547,"y":0,"w":506,"h":900}',
      JSON.stringify(dragCorner({ x: 0, y: 0, w: 100, h: 100 }, "se", 150, 90, 1, 200, 100)) === '{"x":0,"y":0,"w":90,"h":90}',
      JSON.stringify(dragCorner({ x: 50, y: 20, w: 100, h: 60 }, "nw", -50, -50, null, 200, 100)) === '{"x":0,"y":0,"w":150,"h":80}',
      JSON.stringify(moveCrop({ x: 0, y: 0, w: 50, h: 50 }, 500, -9, 200, 100)) === '{"x":150,"y":0,"w":50,"h":50}'
    ];
    // Real render with step-down: left half red, right half blue; crop the right half to 100×100.
    const c = canvas(2000, 1000), x = c.getContext("2d");
    x.fillStyle = "#ff0000"; x.fillRect(0, 0, 1000, 1000); x.fillStyle = "#0000ff"; x.fillRect(1000, 0, 1000, 1000);
    const f = new File([await new Promise(r => c.toBlob(r, "image/png"))], "t.png", { type: "image/png" });
    const img = await loadImage(f);
    const r = await render(img, f, { x: 1000, y: 0, w: 1000, h: 1000 }, Object.assign({}, base, { w: 100, format: "keep", quality: 90 }));
    const back = await loadImage(r.blob), cc = canvas(back.naturalWidth, back.naturalHeight), cx = cc.getContext("2d");
    cx.drawImage(back, 0, 0);
    const px = cx.getImageData(50, 50, 1, 1).data, head = new Uint8Array(await r.blob.slice(0, 4).arrayBuffer());
    g.push(r.type === "image/png" && back.naturalWidth === 100 && back.naturalHeight === 100 && px[2] > 250 && px[0] < 5 && head[1] === 80 && outName({ file: f }, r) === "t-100x100.png");
    return g.every(Boolean) || g.map(String).join(",");
  };
})();
