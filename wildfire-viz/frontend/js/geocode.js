/**
 * geocode.js — English reverse-geocoding for tooltip country + province
 *
 * Strategy:
 *  1. Fast built-in lookup table (bounding boxes for Thai provinces + neighbours)
 *  2. Nominatim API fallback for any point not matched (results cached)
 */

const Geocoder = (() => {

  // ── Nominatim cache (lat,lon → {country, province}) ───────────────
  const _cache = new Map();

  // ── Built-in province table (lat/lon bounding boxes) ─────────────
  // Format: { name, country, latMin, latMax, lonMin, lonMax }
  // Thai provinces sourced from approximate geographic centres + ~0.5° radius
  const PROVINCES = [
    // ── Northern Thailand ──────────────────────────────────────────
    { name: "Chiang Mai",     country: "Thailand", latMin: 17.7, latMax: 20.1, lonMin: 97.5, lonMax: 99.5 },
    { name: "Chiang Rai",     country: "Thailand", latMin: 19.4, latMax: 20.6, lonMin: 99.3, lonMax: 100.7 },
    { name: "Mae Hong Son",   country: "Thailand", latMin: 17.8, latMax: 19.8, lonMin: 97.3, lonMax: 98.5 },
    { name: "Lampang",        country: "Thailand", latMin: 17.6, latMax: 18.9, lonMin: 98.8, lonMax: 100.0 },
    { name: "Lamphun",        country: "Thailand", latMin: 17.8, latMax: 18.6, lonMin: 98.6, lonMax: 99.2 },
    { name: "Phrae",          country: "Thailand", latMin: 17.8, latMax: 18.8, lonMin: 99.8, lonMax: 100.6 },
    { name: "Nan",            country: "Thailand", latMin: 18.2, latMax: 19.6, lonMin: 100.5, lonMax: 101.5 },
    { name: "Uttaradit",      country: "Thailand", latMin: 17.2, latMax: 18.2, lonMin: 99.8, lonMax: 101.0 },
    { name: "Phayao",         country: "Thailand", latMin: 18.8, latMax: 19.8, lonMin: 99.6, lonMax: 100.8 },
    // ── Northeastern Thailand (Isan) ───────────────────────────────
    { name: "Nong Khai",      country: "Thailand", latMin: 17.7, latMax: 18.3, lonMin: 102.0, lonMax: 103.0 },
    { name: "Udon Thani",     country: "Thailand", latMin: 17.2, latMax: 18.0, lonMin: 102.3, lonMax: 103.5 },
    { name: "Nakhon Phanom",  country: "Thailand", latMin: 16.8, latMax: 18.0, lonMin: 103.8, lonMax: 104.8 },
    { name: "Sakon Nakhon",   country: "Thailand", latMin: 16.8, latMax: 17.8, lonMin: 103.2, lonMax: 104.5 },
    { name: "Khon Kaen",      country: "Thailand", latMin: 15.8, latMax: 17.0, lonMin: 101.5, lonMax: 103.0 },
    { name: "Ubon Ratchathani", country: "Thailand", latMin: 14.6, latMax: 16.0, lonMin: 104.0, lonMax: 105.6 },
    { name: "Mukdahan",       country: "Thailand", latMin: 16.2, latMax: 16.9, lonMin: 104.4, lonMax: 105.0 },
    { name: "Loei",           country: "Thailand", latMin: 16.5, latMax: 18.0, lonMin: 100.8, lonMax: 102.4 },
    { name: "Chaiyaphum",     country: "Thailand", latMin: 15.2, latMax: 16.5, lonMin: 100.8, lonMax: 102.3 },
    { name: "Nakhon Ratchasima", country: "Thailand", latMin: 14.3, latMax: 15.7, lonMin: 101.4, lonMax: 103.0 },
    { name: "Surin",          country: "Thailand", latMin: 14.2, latMax: 15.2, lonMin: 103.1, lonMax: 104.4 },
    { name: "Si Sa Ket",      country: "Thailand", latMin: 14.4, latMax: 15.3, lonMin: 103.9, lonMax: 105.0 },
    { name: "Buri Ram",       country: "Thailand", latMin: 14.3, latMax: 15.5, lonMin: 102.5, lonMax: 103.7 },
    { name: "Amnat Charoen",  country: "Thailand", latMin: 15.5, latMax: 16.2, lonMin: 104.4, lonMax: 105.1 },
    { name: "Yasothon",       country: "Thailand", latMin: 15.5, latMax: 16.2, lonMin: 103.9, lonMax: 104.6 },
    { name: "Roi Et",         country: "Thailand", latMin: 15.5, latMax: 16.4, lonMin: 103.1, lonMax: 104.3 },
    { name: "Maha Sarakham",  country: "Thailand", latMin: 15.6, latMax: 16.3, lonMin: 102.4, lonMax: 103.5 },
    { name: "Kalasin",        country: "Thailand", latMin: 16.0, latMax: 17.0, lonMin: 103.1, lonMax: 104.1 },
    { name: "Nong Bua Lam Phu", country: "Thailand", latMin: 16.8, latMax: 17.6, lonMin: 101.9, lonMax: 102.9 },
    // ── Central Thailand ───────────────────────────────────────────
    { name: "Phitsanulok",    country: "Thailand", latMin: 16.2, latMax: 17.5, lonMin: 99.6, lonMax: 101.0 },
    { name: "Phetchabun",     country: "Thailand", latMin: 15.5, latMax: 17.0, lonMin: 100.5, lonMax: 101.7 },
    { name: "Sukhothai",      country: "Thailand", latMin: 16.6, latMax: 17.8, lonMin: 98.9, lonMax: 100.2 },
    { name: "Tak",            country: "Thailand", latMin: 15.8, latMax: 17.8, lonMin: 97.8, lonMax: 99.5 },
    { name: "Kamphaeng Phet", country: "Thailand", latMin: 15.8, latMax: 17.0, lonMin: 98.9, lonMax: 100.0 },
    { name: "Nakhon Sawan",   country: "Thailand", latMin: 15.2, latMax: 16.3, lonMin: 99.6, lonMax: 100.9 },
    { name: "Uthai Thani",    country: "Thailand", latMin: 14.9, latMax: 16.0, lonMin: 98.9, lonMax: 100.1 },
    { name: "Chai Nat",       country: "Thailand", latMin: 14.8, latMax: 15.6, lonMin: 99.6, lonMax: 100.4 },
    { name: "Lop Buri",       country: "Thailand", latMin: 14.5, latMax: 15.8, lonMin: 100.3, lonMax: 101.3 },
    { name: "Saraburi",       country: "Thailand", latMin: 14.3, latMax: 15.0, lonMin: 100.5, lonMax: 101.4 },
    { name: "Ang Thong",      country: "Thailand", latMin: 14.4, latMax: 15.0, lonMin: 100.2, lonMax: 100.6 },
    { name: "Sing Buri",      country: "Thailand", latMin: 14.7, latMax: 15.3, lonMin: 100.0, lonMax: 100.5 },
    { name: "Pathum Thani",   country: "Thailand", latMin: 13.8, latMax: 14.3, lonMin: 100.4, lonMax: 101.0 },
    { name: "Bangkok",        country: "Thailand", latMin: 13.5, latMax: 14.0, lonMin: 100.2, lonMax: 100.9 },
    { name: "Nonthaburi",     country: "Thailand", latMin: 13.8, latMax: 14.2, lonMin: 100.3, lonMax: 100.6 },
    { name: "Samut Prakan",   country: "Thailand", latMin: 13.4, latMax: 13.8, lonMin: 100.5, lonMax: 100.9 },
    { name: "Ayutthaya",      country: "Thailand", latMin: 14.2, latMax: 14.8, lonMin: 100.4, lonMax: 100.9 },
    { name: "Suphan Buri",    country: "Thailand", latMin: 14.2, latMax: 15.2, lonMin: 99.7, lonMax: 100.5 },
    { name: "Nakhon Pathom",  country: "Thailand", latMin: 13.5, latMax: 14.2, lonMin: 99.7, lonMax: 100.3 },
    { name: "Ratchaburi",     country: "Thailand", latMin: 13.1, latMax: 14.1, lonMin: 98.9, lonMax: 100.0 },
    { name: "Kanchanaburi",   country: "Thailand", latMin: 13.8, latMax: 15.8, lonMin: 97.8, lonMax: 99.9 },
    // ── Eastern Thailand ───────────────────────────────────────────
    { name: "Chachoengsao",   country: "Thailand", latMin: 13.3, latMax: 14.0, lonMin: 100.8, lonMax: 101.7 },
    { name: "Prachin Buri",   country: "Thailand", latMin: 13.5, latMax: 14.3, lonMin: 101.0, lonMax: 102.2 },
    { name: "Sa Kaeo",        country: "Thailand", latMin: 13.0, latMax: 14.0, lonMin: 102.0, lonMax: 103.0 },
    { name: "Chon Buri",      country: "Thailand", latMin: 12.8, latMax: 13.6, lonMin: 100.7, lonMax: 101.5 },
    { name: "Rayong",         country: "Thailand", latMin: 12.6, latMax: 13.2, lonMin: 101.1, lonMax: 102.0 },
    { name: "Chanthaburi",    country: "Thailand", latMin: 12.3, latMax: 13.3, lonMin: 101.8, lonMax: 103.0 },
    { name: "Trat",           country: "Thailand", latMin: 11.6, latMax: 12.5, lonMin: 102.3, lonMax: 103.0 },
    // ── Western / Southern Thailand ────────────────────────────────
    { name: "Phetchaburi",    country: "Thailand", latMin: 12.6, latMax: 13.5, lonMin: 99.5, lonMax: 100.3 },
    { name: "Prachuap Khiri Khan", country: "Thailand", latMin: 11.2, latMax: 12.8, lonMin: 99.2, lonMax: 100.0 },
    { name: "Chumphon",       country: "Thailand", latMin: 9.8,  latMax: 11.4, lonMin: 98.8, lonMax: 100.1 },
    { name: "Ranong",         country: "Thailand", latMin: 9.3,  latMax: 10.5, lonMin: 98.3, lonMax: 99.0 },
    { name: "Surat Thani",    country: "Thailand", latMin: 8.8,  latMax: 10.0, lonMin: 98.6, lonMax: 100.2 },
    { name: "Nakhon Si Thammarat", country: "Thailand", latMin: 7.8, latMax: 9.2, lonMin: 99.6, lonMax: 100.7 },
    { name: "Phang Nga",      country: "Thailand", latMin: 8.1,  latMax: 9.5,  lonMin: 98.1, lonMax: 99.1 },
    { name: "Krabi",          country: "Thailand", latMin: 7.5,  latMax: 8.6,  lonMin: 98.8, lonMax: 99.7 },
    { name: "Phuket",         country: "Thailand", latMin: 7.7,  latMax: 8.3,  lonMin: 98.2, lonMax: 98.6 },
    { name: "Trang",          country: "Thailand", latMin: 7.1,  latMax: 8.0,  lonMin: 99.2, lonMax: 100.1 },
    { name: "Phatthalung",    country: "Thailand", latMin: 6.9,  latMax: 7.8,  lonMin: 99.8, lonMax: 100.5 },
    { name: "Satun",          country: "Thailand", latMin: 6.3,  latMax: 7.2,  lonMin: 99.5, lonMax: 100.3 },
    { name: "Songkhla",       country: "Thailand", latMin: 6.5,  latMax: 7.7,  lonMin: 99.9, lonMax: 101.0 },
    { name: "Pattani",        country: "Thailand", latMin: 6.5,  latMax: 7.0,  lonMin: 100.8, lonMax: 101.5 },
    { name: "Yala",           country: "Thailand", latMin: 5.8,  latMax: 6.7,  lonMin: 100.9, lonMax: 101.7 },
    { name: "Narathiwat",     country: "Thailand", latMin: 5.6,  latMax: 6.5,  lonMin: 101.6, lonMax: 102.3 },

    // ── Myanmar (major states/regions) ────────────────────────────
    { name: "Kachin State",   country: "Myanmar", latMin: 23.5, latMax: 28.5, lonMin: 96.0, lonMax: 99.0 },
    { name: "Shan State",     country: "Myanmar", latMin: 19.0, latMax: 24.0, lonMin: 96.5, lonMax: 101.5 },
    { name: "Mandalay Region",country: "Myanmar", latMin: 19.5, latMax: 22.5, lonMin: 94.5, lonMax: 97.5 },
    { name: "Kayah State",    country: "Myanmar", latMin: 18.5, latMax: 20.0, lonMin: 96.8, lonMax: 98.5 },
    { name: "Kayin State",    country: "Myanmar", latMin: 16.0, latMax: 19.0, lonMin: 96.5, lonMax: 99.2 },
    { name: "Sagaing Region", country: "Myanmar", latMin: 21.0, latMax: 26.0, lonMin: 92.5, lonMax: 96.5 },
    { name: "Bago Region",    country: "Myanmar", latMin: 16.5, latMax: 19.5, lonMin: 95.0, lonMax: 97.5 },
    { name: "Mon State",      country: "Myanmar", latMin: 15.0, latMax: 17.5, lonMin: 97.0, lonMax: 98.8 },
    { name: "Tanintharyi Region", country: "Myanmar", latMin: 10.0, latMax: 16.0, lonMin: 97.5, lonMax: 99.5 },
    { name: "Ayeyarwady Region", country: "Myanmar", latMin: 15.5, latMax: 18.5, lonMin: 93.5, lonMax: 96.5 },
    { name: "Yangon Region",  country: "Myanmar", latMin: 16.0, latMax: 18.0, lonMin: 95.5, lonMax: 97.5 },
    { name: "Chin State",     country: "Myanmar", latMin: 20.5, latMax: 24.5, lonMin: 92.5, lonMax: 95.0 },
    { name: "Magway Region",  country: "Myanmar", latMin: 19.0, latMax: 22.5, lonMin: 93.5, lonMax: 96.5 },
    { name: "Rakhine State",  country: "Myanmar", latMin: 17.5, latMax: 21.5, lonMin: 92.0, lonMax: 95.5 },

    // ── Laos ──────────────────────────────────────────────────────
    { name: "Phongsali Province",   country: "Laos", latMin: 21.0, latMax: 22.5, lonMin: 100.5, lonMax: 102.5 },
    { name: "Luang Namtha Province", country: "Laos", latMin: 20.5, latMax: 22.0, lonMin: 100.5, lonMax: 102.0 },
    { name: "Oudomxay Province",    country: "Laos", latMin: 20.0, latMax: 21.5, lonMin: 101.0, lonMax: 102.8 },
    { name: "Luang Prabang Province", country: "Laos", latMin: 19.0, latMax: 21.0, lonMin: 101.5, lonMax: 103.5 },
    { name: "Xiangkhouang Province", country: "Laos", latMin: 19.0, latMax: 20.5, lonMin: 102.5, lonMax: 104.0 },
    { name: "Vientiane Province",   country: "Laos", latMin: 17.5, latMax: 19.5, lonMin: 101.5, lonMax: 103.5 },
    { name: "Vientiane Capital",    country: "Laos", latMin: 17.5, latMax: 18.5, lonMin: 102.3, lonMax: 103.0 },
    { name: "Bolikhamxay Province", country: "Laos", latMin: 17.0, latMax: 18.8, lonMin: 103.0, lonMax: 105.0 },
    { name: "Khammouane Province",  country: "Laos", latMin: 16.5, latMax: 17.8, lonMin: 104.0, lonMax: 106.0 },
    { name: "Savannakhet Province", country: "Laos", latMin: 15.5, latMax: 17.0, lonMin: 104.5, lonMax: 106.5 },
    { name: "Champasak Province",   country: "Laos", latMin: 13.9, latMax: 15.5, lonMin: 104.5, lonMax: 106.5 },
    { name: "Attapeu Province",     country: "Laos", latMin: 13.8, latMax: 15.3, lonMin: 106.5, lonMax: 108.0 },

    // ── Cambodia ──────────────────────────────────────────────────
    { name: "Siem Reap Province",   country: "Cambodia", latMin: 12.5, latMax: 14.5, lonMin: 103.0, lonMax: 105.0 },
    { name: "Phnom Penh",           country: "Cambodia", latMin: 11.3, latMax: 12.0, lonMin: 104.7, lonMax: 105.2 },
    { name: "Sihanoukville",        country: "Cambodia", latMin: 10.3, latMax: 11.0, lonMin: 103.5, lonMax: 104.3 },
    { name: "Battambang Province",  country: "Cambodia", latMin: 12.5, latMax: 13.8, lonMin: 102.5, lonMax: 103.7 },
    { name: "Kampong Cham Province", country: "Cambodia", latMin: 11.5, latMax: 12.5, lonMin: 105.0, lonMax: 106.5 },
    { name: "Kampot Province",      country: "Cambodia", latMin: 10.2, latMax: 11.3, lonMin: 104.0, lonMax: 105.0 },
    { name: "Mondulkiri Province",  country: "Cambodia", latMin: 12.0, latMax: 13.5, lonMin: 106.5, lonMax: 108.0 },
    { name: "Ratanakiri Province",  country: "Cambodia", latMin: 13.0, latMax: 14.7, lonMin: 106.0, lonMax: 107.8 },
    { name: "Kratie Province",      country: "Cambodia", latMin: 12.0, latMax: 13.5, lonMin: 105.5, lonMax: 107.0 },
    { name: "Stung Treng Province", country: "Cambodia", latMin: 13.0, latMax: 14.5, lonMin: 105.0, lonMax: 107.0 },
    { name: "Preah Vihear Province", country: "Cambodia", latMin: 13.5, latMax: 14.5, lonMin: 104.0, lonMax: 106.0 },
    { name: "Oddar Meanchey",       country: "Cambodia", latMin: 13.5, latMax: 14.8, lonMin: 103.0, lonMax: 104.5 },

    // ── Vietnam (border provinces) ─────────────────────────────────
    { name: "Dien Bien Province",   country: "Vietnam", latMin: 21.0, latMax: 22.5, lonMin: 102.5, lonMax: 103.8 },
    { name: "Son La Province",      country: "Vietnam", latMin: 20.5, latMax: 22.0, lonMin: 103.3, lonMax: 105.0 },
    { name: "Lai Chau Province",    country: "Vietnam", latMin: 21.5, latMax: 23.0, lonMin: 102.0, lonMax: 103.5 },
    { name: "Ha Giang Province",    country: "Vietnam", latMin: 22.0, latMax: 23.5, lonMin: 104.0, lonMax: 105.5 },
    { name: "Kon Tum Province",     country: "Vietnam", latMin: 14.0, latMax: 15.5, lonMin: 107.0, lonMax: 108.5 },
    { name: "Gia Lai Province",     country: "Vietnam", latMin: 12.5, latMax: 14.5, lonMin: 107.5, lonMax: 109.0 },
    { name: "Tay Ninh Province",    country: "Vietnam", latMin: 11.0, latMax: 12.0, lonMin: 105.5, lonMax: 106.5 },
    { name: "An Giang Province",    country: "Vietnam", latMin: 10.0, latMax: 11.0, lonMin: 104.5, lonMax: 105.7 },

    // ── Malaysia ──────────────────────────────────────────────────
    { name: "Perlis State",         country: "Malaysia", latMin: 6.2, latMax: 6.9, lonMin: 99.9, lonMax: 100.7 },
    { name: "Kedah State",          country: "Malaysia", latMin: 5.3, latMax: 6.7, lonMin: 100.0, lonMax: 101.0 },
    { name: "Penang State",         country: "Malaysia", latMin: 5.1, latMax: 5.6, lonMin: 100.1, lonMax: 100.6 },
    { name: "Kelantan State",       country: "Malaysia", latMin: 4.8, latMax: 6.3, lonMin: 101.5, lonMax: 102.7 },
    { name: "Perak State",          country: "Malaysia", latMin: 3.7, latMax: 5.8, lonMin: 100.3, lonMax: 101.8 },
  ];

  /**
   * Look up the region for (lat, lon) using the built-in table first,
   * then fall back to Nominatim. Returns { country, province }.
   */
  async function lookup(lat, lon) {
    const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (_cache.has(key)) return _cache.get(key);

    // 1) Built-in fast lookup
    const match = _findInTable(lat, lon);
    if (match) {
      _cache.set(key, match);
      return match;
    }

    // 2) Nominatim fallback (throttled, English only)
    try {
      const result = await _nominatim(lat, lon);
      _cache.set(key, result);
      return result;
    } catch (_) {
      const fallback = { country: '—', province: '—' };
      _cache.set(key, fallback);
      return fallback;
    }
  }

  function _findInTable(lat, lon) {
    // Find most specific match (smallest bounding box)
    let best = null;
    let bestArea = Infinity;
    for (const p of PROVINCES) {
      if (lat >= p.latMin && lat <= p.latMax && lon >= p.lonMin && lon <= p.lonMax) {
        const area = (p.latMax - p.latMin) * (p.lonMax - p.lonMin);
        if (area < bestArea) {
          bestArea = area;
          best = { country: p.country, province: p.name };
        }
      }
    }
    return best;
  }

  // Rate-limit: one request per 200 ms
  let _lastNominatimCall = 0;
  async function _nominatim(lat, lon) {
    const now = Date.now();
    const wait = 200 - (now - _lastNominatimCall);
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    _lastNominatimCall = Date.now();

    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json&accept-language=en&zoom=10`;
    const res = await fetch(url, { headers: { 'Accept-Language': 'en' } });
    if (!res.ok) throw new Error('Nominatim failed');
    const data = await res.json();
    const addr = data.address || {};
    return {
      country:  addr.country  || '—',
      province: addr.state || addr.province || addr.county || addr.city || addr.town || '—',
    };
  }

  return { lookup };

})();