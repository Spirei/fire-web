export function validateModelEndpoint(input: string): string | null {
  if (!input || input.length > 2048) return null;
  try {
    const url = new URL(input);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.username || url.password || url.hash) return null;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
    if (!host || host === "0.0.0.0" || host === "metadata.google.internal" || host === "metadata.azure.internal") return null;
    if (/^169\.254\./.test(host) || /^fe[89ab][0-9a-f]:/i.test(host) || host === "100.100.100.200") return null;
    // Keep explicitly configured local gateways, but never send a bearer key over public HTTP.
    if (url.protocol === "http:") {
      const octets = host.split(".").map(Number);
      const privateV4 = octets.length === 4 && octets.every(part => Number.isInteger(part) && part >= 0 && part <= 255)
        && (octets[0] === 10 || octets[0] === 127 || (octets[0] === 192 && octets[1] === 168) || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31));
      if (!(privateV4 || host === "localhost" || host === "::1" || /^f[cd][0-9a-f]{2}:/i.test(host))) return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
