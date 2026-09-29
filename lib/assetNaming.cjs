const { createHash } = require('node:crypto');
/** Short storage names are independent of human-readable labels. */
function assetFilename({ name = '', code = '', market = '', type = '' }, ext) {
  const clean = value => String(value).replace(/[^a-zA-Z0-9._-]/g, '').replace(/^\.+/, '').slice(0, 64);
  const suffix = String(ext).toLowerCase();
  if (!/^\.[a-z0-9]+$/.test(suffix)) throw new Error('Invalid asset extension');
  let key = clean(type === 'market' ? market || code : code);
  if (type === 'flag' || type === 'icon') key = key.toLowerCase();
  if (key) return key + suffix;
  const ascii = /^[a-zA-Z0-9._ -]+$/.test(name) ? clean(name.replace(/\s+/g, '-')) : '';
  return (ascii || `${clean(type) || 'asset'}-${createHash('sha256').update(String(name)).digest('hex').slice(0, 12)}`) + suffix;
}
module.exports = { assetFilename };
