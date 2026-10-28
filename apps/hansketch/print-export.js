/* Dependency-free print file writers. Geometry and rendering stay in HanSketch.
   TIFF: baseline, little-endian, uncompressed 8-bit RGB, resolution in inches.
   PDF: vector paths supplied by the caller, with lossless soft-mask images for
   relief shadows. Each page has the same physical MediaBox and a layer label. */
(() => {
  "use strict";

  function tiff(image, dpi) {
    const { width, height, data } = image;
    const count = 14, extra = 8 + 2 + count * 12 + 4;
    const pixels = extra + 6 + 16;
    const bytes = new Uint8Array(pixels + width * height * 3);
    const view = new DataView(bytes.buffer);
    const u16 = (p, n) => view.setUint16(p, n, true);
    const u32 = (p, n) => view.setUint32(p, n, true);
    bytes[0] = bytes[1] = 73;
    u16(2, 42); u32(4, 8); u16(8, count);
    let pos = 10;
    const tag = (id, type, length, value) => {
      u16(pos, id); u16(pos + 2, type); u32(pos + 4, length);
      if (type === 3 && length === 1) u16(pos + 8, value);
      else u32(pos + 8, value);
      pos += 12;
    };
    tag(256, 4, 1, width); tag(257, 4, 1, height);
    tag(258, 3, 3, extra); tag(259, 3, 1, 1); tag(262, 3, 1, 2);
    tag(273, 4, 1, pixels); tag(274, 3, 1, 1); tag(277, 3, 1, 3);
    tag(278, 4, 1, height); tag(279, 4, 1, width * height * 3);
    tag(282, 5, 1, extra + 6); tag(283, 5, 1, extra + 14);
    tag(284, 3, 1, 1); tag(296, 3, 1, 2);
    u32(pos, 0);
    u16(extra, 8); u16(extra + 2, 8); u16(extra + 4, 8);
    const resolution = Math.round(dpi * 1000);
    u32(extra + 6, resolution); u32(extra + 10, 1000);
    u32(extra + 14, resolution); u32(extra + 18, 1000);
    for (let src = 0, dst = pixels; src < data.length; src += 4) {
      bytes[dst++] = data[src]; bytes[dst++] = data[src + 1]; bytes[dst++] = data[src + 2];
    }
    return new Blob([bytes], { type: "image/tiff" });
  }

  const utf16 = text => "<feff" + Array.from(String(text), ch => {
    // Iterate code units too, so supplementary characters keep their surrogate pair.
    let hex = "";
    for (let i = 0; i < ch.length; i++) hex += ch.charCodeAt(i).toString(16).padStart(4, "0");
    return hex;
  }).join("") + ">";

  async function pdf(pages, widthMm, heightMm) {
    const encoder = new TextEncoder();
    const objects = [null, null, null]; // reserve catalog (1) and page tree (2)
    const add = value => (objects.push(value), objects.length - 1);
    const stream = async (bytes, dictionary = "", compress = true) => {
      let filter = "";
      if (compress && typeof CompressionStream !== "undefined") {
        bytes = new Uint8Array(await new Response(new Blob([bytes]).stream()
          .pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
        filter = "/Filter /FlateDecode ";
      }
      return add([encoder.encode(`<< ${dictionary} ${filter}/Length ${bytes.length} >>\nstream\n`),
        bytes, encoder.encode("\nendstream")]);
    };
    const pageIds = [], labels = [];
    const widthPt = widthMm * 72 / 25.4, heightPt = heightMm * 72 / 25.4;
    for (const page of pages) {
      const images = [];
      for (const getImage of (page.images || [])) {
        // Lazily render and compress one shadow at a time; never retain A2 RGBA
        // buffers for every layer at once.
        const image = await getImage();
        const rgb = new Uint8Array(image.width * image.height * 3);
        const alpha = new Uint8Array(image.width * image.height);
        for (let i = 0, j = 0; i < image.data.length; i += 4, j++) {
          rgb[j * 3] = image.data[i]; rgb[j * 3 + 1] = image.data[i + 1];
          rgb[j * 3 + 2] = image.data[i + 2]; alpha[j] = image.data[i + 3];
        }
        const dims = `/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /BitsPerComponent 8`;
        const mask = await stream(alpha, `${dims} /ColorSpace /DeviceGray`);
        images.push(await stream(rgb, `${dims} /ColorSpace /DeviceRGB /SMask ${mask} 0 R`));
      }
      const content = await stream(encoder.encode(page.commands));
      const resources = images.map((id, i) => `/Im${i} ${id} 0 R`).join(" ");
      pageIds.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${widthPt} ${heightPt}] `
        + `/Resources << /XObject << ${resources} >> >> /Contents ${content} 0 R >>`));
      labels.push(`${pageIds.length - 1} << /P ${utf16(page.name || "Artwork")} >>`);
    }
    objects[1] = `<< /Type /Catalog /Pages 2 0 R /PageLabels << /Nums [${labels.join(" ")}] >> >>`;
    objects[2] = `<< /Type /Pages /Count ${pageIds.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(" ")}] >>`;
    const chunks = [encoder.encode("%PDF-1.4\n%HanSketch\n")], offsets = [0];
    let length = chunks[0].length;
    const append = bytes => { chunks.push(bytes); length += bytes.length; };
    for (let id = 1; id < objects.length; id++) {
      offsets.push(length);
      append(encoder.encode(`${id} 0 obj\n`));
      const value = objects[id];
      if (Array.isArray(value)) value.forEach(append);
      else append(encoder.encode(value));
      append(encoder.encode("\nendobj\n"));
    }
    const xref = length;
    append(encoder.encode(`xref\n0 ${objects.length}\n0000000000 65535 f \n`
      + offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")
      + `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`));
    return new Blob(chunks, { type: "application/pdf" });
  }

  window.HanSketchPrint = Object.freeze({ tiff, pdf });
})();
