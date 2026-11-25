// Light copies of a photo for the customer app (owner 2026-11-25: the shipment photos loaded slowly).
// Staff upload photos at full camera size (several MB); the app showed them as they are, even in the
// small squares. From each image two WebP copies are made: a thumbnail for the squares and a preview
// for the viewer. The original is kept untouched for "download".
// sharp cannot read HEIC: such a file (and anything that is not a readable image) gets no copies, and
// the app keeps showing the original.
const sharp = require('sharp');

const SIZES = {
  thumb: { width: 480, quality: 68 },
  preview: { width: 1600, quality: 80 },
};

const isImage = (mimetype = '', name = '') => /^image\/(jpeg|jpg|png|webp|gif|avif|tiff)$/i.test(mimetype)
  || /\.(jpe?g|png|webp|gif|avif|tiff?)$/i.test(name);

// { thumb: Buffer, preview: Buffer } or null. rotate() turns the photo the way the phone held it (EXIF);
// a photo smaller than a size is never enlarged.
async function makeVariants(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) return null;
  try {
    const out = {};
    for (const [key, { width, quality }] of Object.entries(SIZES)) {
      out[key] = await sharp(buffer, { failOn: 'none', limitInputPixels: 120e6 })
        .rotate()
        .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
        .webp({ quality, effort: 4 })
        .toBuffer();
    }
    return out;
  } catch (error) {
    console.log('image variants:', error.message);
    return null;
  }
}

module.exports = { isImage, makeVariants, SIZES };
