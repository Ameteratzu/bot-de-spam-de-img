import sharp from 'sharp';

const clamp = (value) => Math.max(0, Math.min(1, value));

// Recolor the existing pixels without OCR or redrawing the trade values.
// White becomes black, neutral text becomes white, and trade accents retain
// their direction colors. The source dimensions and every glyph stay in place.
export async function darkenTradeScreenshot(source) {
  const { data, info } = await sharp(source).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const result = Buffer.alloc(data.length);
  for (let offset = 0; offset < data.length; offset += 3) {
    const red = data[offset];
    const green = data[offset + 1];
    const blue = data[offset + 2];
    if (blue > red + 24 && blue > green + 10) {
      const strength = clamp(Math.max((255 - red) / 255, (255 - green) / 220));
      result[offset] = Math.round(35 * strength);
      result[offset + 1] = Math.round(150 * strength);
      result[offset + 2] = Math.round(255 * strength);
    } else if (red > green + 25 && red > blue + 20) {
      const strength = clamp(Math.max((255 - green) / 255, (255 - blue) / 255));
      result[offset] = Math.round(235 * strength);
      result[offset + 1] = Math.round(92 * strength);
      result[offset + 2] = Math.round(76 * strength);
    } else {
      const darkness = 1 - (red * .2126 + green * .7152 + blue * .0722) / 255;
      const brightness = Math.round(246 * Math.pow(clamp(darkness), .88));
      result[offset] = brightness;
      result[offset + 1] = brightness;
      result[offset + 2] = brightness;
    }
  }
  return sharp(result, { raw: { width: info.width, height: info.height, channels: 3 } }).png().toBuffer();
}
