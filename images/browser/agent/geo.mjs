// Copied from tvdavies/brwsr@0d22bf8 (container/agent/geo.mjs) for Kantel's browser runtime
// (docs/design/browser-runtime.md). Kantel changes: none (server.mjs no longer passes a proxy port).
// Where the browser's traffic appears to come from, so its time zone can say
// the same thing as its IP address (a UTC browser on a Houston IP is a tell).
//
// The agent asks Cloudflare's trace endpoint (https://www.cloudflare.com/cdn-cgi/trace)
// which country and Cloudflare data centre (colo) its egress reaches, through
// the session's own proxy forwarder when it has one, so the answer is the
// one websites see. The country gives the time zone; in countries with
// several, the colo picks one. Nothing here is sent anywhere else.
import https from "node:https";
import http from "node:http";
import tls from "node:tls";

const TRACE_HOST = "www.cloudflare.com";
const TRACE_PATH = "/cdn-cgi/trace";

/** One IANA zone per country: its capital's, or where most people live. */
const COUNTRY_TZ = {
  AD: "Europe/Andorra", AE: "Asia/Dubai", AF: "Asia/Kabul", AL: "Europe/Tirane", AM: "Asia/Yerevan", AO: "Africa/Luanda",
  AR: "America/Argentina/Buenos_Aires", AT: "Europe/Vienna", AU: "Australia/Sydney", AZ: "Asia/Baku", BA: "Europe/Sarajevo",
  BD: "Asia/Dhaka", BE: "Europe/Brussels", BG: "Europe/Sofia", BH: "Asia/Bahrain", BO: "America/La_Paz", BR: "America/Sao_Paulo",
  BY: "Europe/Minsk", CA: "America/Toronto", CH: "Europe/Zurich", CL: "America/Santiago", CN: "Asia/Shanghai", CO: "America/Bogota",
  CR: "America/Costa_Rica", CY: "Asia/Nicosia", CZ: "Europe/Prague", DE: "Europe/Berlin", DK: "Europe/Copenhagen",
  DO: "America/Santo_Domingo", DZ: "Africa/Algiers", EC: "America/Guayaquil", EE: "Europe/Tallinn", EG: "Africa/Cairo",
  ES: "Europe/Madrid", FI: "Europe/Helsinki", FR: "Europe/Paris", GB: "Europe/London", GE: "Asia/Tbilisi", GH: "Africa/Accra",
  GR: "Europe/Athens", GT: "America/Guatemala", HK: "Asia/Hong_Kong", HR: "Europe/Zagreb", HU: "Europe/Budapest",
  ID: "Asia/Jakarta", IE: "Europe/Dublin", IL: "Asia/Jerusalem", IN: "Asia/Kolkata", IQ: "Asia/Baghdad", IR: "Asia/Tehran",
  IS: "Atlantic/Reykjavik", IT: "Europe/Rome", JM: "America/Jamaica", JO: "Asia/Amman", JP: "Asia/Tokyo", KE: "Africa/Nairobi",
  KH: "Asia/Phnom_Penh", KR: "Asia/Seoul", KW: "Asia/Kuwait", KZ: "Asia/Almaty", LB: "Asia/Beirut", LK: "Asia/Colombo",
  LT: "Europe/Vilnius", LU: "Europe/Luxembourg", LV: "Europe/Riga", MA: "Africa/Casablanca", MD: "Europe/Chisinau",
  ME: "Europe/Podgorica", MK: "Europe/Skopje", MN: "Asia/Ulaanbaatar", MO: "Asia/Macau", MT: "Europe/Malta", MU: "Indian/Mauritius",
  MX: "America/Mexico_City", MY: "Asia/Kuala_Lumpur", MZ: "Africa/Maputo", NG: "Africa/Lagos", NL: "Europe/Amsterdam",
  NO: "Europe/Oslo", NP: "Asia/Kathmandu", NZ: "Pacific/Auckland", OM: "Asia/Muscat", PA: "America/Panama", PE: "America/Lima",
  PH: "Asia/Manila", PK: "Asia/Karachi", PL: "Europe/Warsaw", PR: "America/Puerto_Rico", PT: "Europe/Lisbon", PY: "America/Asuncion",
  QA: "Asia/Qatar", RO: "Europe/Bucharest", RS: "Europe/Belgrade", RU: "Europe/Moscow", RW: "Africa/Kigali", SA: "Asia/Riyadh",
  SE: "Europe/Stockholm", SG: "Asia/Singapore", SI: "Europe/Ljubljana", SK: "Europe/Bratislava", SN: "Africa/Dakar",
  SV: "America/El_Salvador", TH: "Asia/Bangkok", TN: "Africa/Tunis", TR: "Europe/Istanbul", TW: "Asia/Taipei",
  TZ: "Africa/Dar_es_Salaam", UA: "Europe/Kyiv", UG: "Africa/Kampala", US: "America/New_York", UY: "America/Montevideo",
  UZ: "Asia/Tashkent", VE: "America/Caracas", VN: "Asia/Ho_Chi_Minh", ZA: "Africa/Johannesburg", ZM: "Africa/Lusaka",
  ZW: "Africa/Harare",
};

/** Colos in countries with more than one zone, where the country's default would be wrong. */
const COLO_TZ = {
  // United States (default New York)
  ORD: "America/Chicago", DFW: "America/Chicago", IAH: "America/Chicago", MCI: "America/Chicago", MSP: "America/Chicago",
  STL: "America/Chicago", MEM: "America/Chicago", MSY: "America/Chicago", OMA: "America/Chicago", AUS: "America/Chicago",
  SAT: "America/Chicago", OKC: "America/Chicago", BNA: "America/Chicago", MKE: "America/Chicago", DSM: "America/Chicago",
  TUL: "America/Chicago", LIT: "America/Chicago", FSD: "America/Chicago", FAR: "America/Chicago",
  DEN: "America/Denver", SLC: "America/Denver", ABQ: "America/Denver", BOI: "America/Boise", PHX: "America/Phoenix",
  LAX: "America/Los_Angeles", SJC: "America/Los_Angeles", SFO: "America/Los_Angeles", SEA: "America/Los_Angeles",
  PDX: "America/Los_Angeles", SMF: "America/Los_Angeles", SAN: "America/Los_Angeles", LAS: "America/Los_Angeles",
  FAT: "America/Los_Angeles", ANC: "America/Anchorage", HNL: "Pacific/Honolulu",
  // Canada (default Toronto)
  YVR: "America/Vancouver", YYC: "America/Edmonton", YEG: "America/Edmonton", YWG: "America/Winnipeg", YXE: "America/Regina",
  YHZ: "America/Halifax",
  // Australia (default Sydney)
  BNE: "Australia/Brisbane", PER: "Australia/Perth", ADL: "Australia/Adelaide", HBA: "Australia/Hobart", MEL: "Australia/Melbourne",
  // Brazil (default São Paulo)
  MAO: "America/Manaus", BEL: "America/Belem", FOR: "America/Fortaleza", REC: "America/Recife",
  // Mexico (default Mexico City)
  TIJ: "America/Tijuana",
  // Russia (default Moscow)
  SVX: "Asia/Yekaterinburg", KJA: "Asia/Krasnoyarsk", OVB: "Asia/Novosibirsk", KHV: "Asia/Vladivostok",
};

/** The time zone for a country and colo; null when we can't tell. */
export function timezoneFor(country, colo) {
  if (colo && COLO_TZ[colo.toUpperCase()]) return COLO_TZ[colo.toUpperCase()];
  return COUNTRY_TZ[(country ?? "").toUpperCase()] ?? null;
}

/** key=value lines of a trace response as an object. */
export function parseTrace(text) {
  const out = {};
  for (const line of String(text).split("\n")) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** GET the trace over a socket CONNECTed through the local forwarder (the session's proxies). */
function viaForwarder(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method: "CONNECT", path: `${TRACE_HOST}:443`, timeout: timeoutMs });
    req.on("connect", (res, socket) => {
      if (res.statusCode !== 200) return reject(new Error(`forwarder answered ${res.statusCode}`)), socket.destroy();
      const s = tls.connect({ socket, servername: TRACE_HOST });
      let body = "";
      s.on("secureConnect", () => s.write(`GET ${TRACE_PATH} HTTP/1.1\r\nHost: ${TRACE_HOST}\r\nConnection: close\r\nUser-Agent: brwsr\r\n\r\n`));
      s.on("data", (d) => (body += d));
      s.on("end", () => resolve(body.slice(body.indexOf("\r\n\r\n") + 4)));
      s.on("error", reject);
      s.setTimeout(timeoutMs, () => s.destroy(new Error("timeout")));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

function direct(timeoutMs) {
  return new Promise((resolve, reject) => {
    const req = https.get({ host: TRACE_HOST, path: TRACE_PATH, timeout: timeoutMs, headers: { "user-agent": "brwsr" } }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve(body));
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
  });
}

/**
 * {country, colo, timezone} of the egress (through the forwarder on
 * `proxyPort` if given), or null if it couldn't be told in time.
 */
export async function egressGeo({ proxyPort, timeoutMs = 2500 } = {}) {
  try {
    const t = parseTrace(proxyPort ? await viaForwarder(proxyPort, timeoutMs) : await direct(timeoutMs));
    if (!t.loc) return null;
    return { country: t.loc, colo: t.colo ?? null, timezone: timezoneFor(t.loc, t.colo) };
  } catch {
    return null;
  }
}
