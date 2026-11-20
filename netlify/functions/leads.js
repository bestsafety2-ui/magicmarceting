// Magic MARCeting — lead search (Netlify function)
// POST { city, type }  ->  { success, total, businesses: [...] }  or  { error }
// Free data: OpenStreetMap (Nominatim/Photon to find the city, Overpass for businesses). No API key.

const UA = 'MagicMARCeting-LeadFinder/2.0 (+https://magicmarceting.netlify.app)';
const BUDGET_MS = 9000; // Netlify cuts functions off at ~10s, so stay under it

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// Each business type searches several OpenStreetMap tags, so more real places show up
const TYPE_TAGS = {
  'restaurant':       ['amenity~"^(restaurant|cafe|fast_food|bar|pub|ice_cream)$"'],
  'salon':            ['shop~"^(hairdresser|beauty|barber|cosmetics|massage|tattoo|nails)$"'],
  'gym':              ['leisure~"^(fitness_centre|sports_centre)$"', 'sport~"^(martial_arts|boxing|yoga|crossfit)$"'],
  'contractor':       ['craft~"^(builder|carpenter|electrician|plumber|roofer|painter|hvac|tiler|floorer|plasterer|window_construction)$"', 'office~"^(construction_company|contractor)$"'],
  'realtor':          ['office~"^(estate_agent|property_management)$"'],
  'retail':           ['shop~"^(clothes|boutique|shoes|gift|jewelry|fashion_accessories|bag)$"'],
  'food truck':       ['amenity~"^(fast_food|food_court)$"', 'street_vendor=yes'],
  'cleaning service': ['shop~"^(dry_cleaning|laundry)$"', 'craft=cleaning', 'office=cleaning'],
  'dentist':          ['amenity=dentist', 'healthcare=dentist'],
  'auto repair':      ['shop~"^(car_repair|tyres|car_parts|car)$"', 'amenity=car_wash']
};

function respond(statusCode, obj) {
  return { statusCode, headers: HEADERS, body: JSON.stringify(obj) };
}

async function getJSON(url, ms, extraHeaders) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept': 'application/json', ...(extraHeaders || {}) },
      signal: ctrl.signal
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Find the city's coordinates. Nominatim first, Photon as a backup.
async function geocode(city) {
  try {
    const q = `https://nominatim.openstreetmap.org/search?format=json&limit=1&q=${encodeURIComponent(city)}`;
    const data = await getJSON(q, 3500, { 'Accept-Language': 'en' });
    if (data && data[0]) return { lat: +data[0].lat, lon: +data[0].lon, label: data[0].display_name };
  } catch (e) { /* fall through to backup */ }
  try {
    const q = `https://photon.komoot.io/api/?limit=1&q=${encodeURIComponent(city)}`;
    const data = await getJSON(q, 3000);
    const f = data && data.features && data.features[0];
    if (f) return { lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0], label: f.properties.name };
  } catch (e) { /* nothing found */ }
  return null;
}

// Ask several Overpass servers at once and take whichever answers first
async function overpass(query, ms) {
  const servers = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter'
  ];
  const attempts = servers.map(s =>
    getJSON(`${s}?data=${encodeURIComponent(query)}`, ms).then(d => {
      if (!d || !Array.isArray(d.elements)) throw new Error('bad response');
      return d;
    })
  );
  return Promise.any(attempts);
}

function buildQuery(tags, lat, lon, radius) {
  const around = `(around:${radius},${lat},${lon})`;
  const parts = tags.map(t => `nwr[${t}][name]${around};`).join('');
  return `[out:json][timeout:8];(${parts});out center tags 200;`;
}

function toBusiness(el, type, city) {
  const t = el.tags || {};
  const website = t.website || t['contact:website'] || t.url || null;
  // Chains (McDonald's, Great Clips...) always have a corporate site, so they aren't real leads
  const isChain = !!(t.brand || t['brand:wikidata']);
  const phone = t.phone || t['contact:phone'] || t['contact:mobile'] || 'N/A';
  const street = [t['addr:housenumber'], t['addr:street']].filter(Boolean).join(' ');
  const address = [street, t['addr:city']].filter(Boolean).join(', ') || city;
  return {
    name: t.name,
    address,
    phone,
    website,
    hasWebsite: !!website || isChain,
    chain: isChain,
    email: t.email || t['contact:email'] || null,
    instagram: t['contact:instagram'] || null,
    facebook: t['contact:facebook'] || null,
    rating: 'N/A',
    categories: type
  };
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return respond(200, {});
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Use POST with { city, type }' });

  const started = Date.now();
  let body;
  try { body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {}); }
  catch (e) { return respond(400, { error: 'Invalid JSON' }); }

  const city = String(body.city || '').trim();
  const type = String(body.type || 'restaurant').trim();
  if (!city) return respond(400, { error: 'Please enter a city.' });
  const tags = TYPE_TAGS[type] || TYPE_TAGS['restaurant'];

  const geo = await geocode(city);
  if (!geo) {
    return respond(200, { error: `Couldn't find "${city}". Try adding the state, like "Lombard, IL".` });
  }

  // Search 6 km around the city; if that's thin and time allows, widen to 15 km
  let elements = [];
  for (const radius of [6000, 15000]) {
    const timeLeft = BUDGET_MS - (Date.now() - started);
    if (timeLeft < 2500) break;
    try {
      const data = await overpass(buildQuery(tags, geo.lat, geo.lon, radius), timeLeft - 300);
      elements = data.elements;
    } catch (e) {
      if (!elements.length) {
        return respond(200, { error: 'The map servers are busy right now. Please try again in a minute.' });
      }
      break;
    }
    if (elements.length >= 25) break;
  }

  const seen = new Set();
  const businesses = [];
  for (const el of elements) {
    const name = el.tags && el.tags.name;
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    businesses.push(toBusiness(el, type, city));
  }

  // No-website leads first, then cap the list
  businesses.sort((a, b) => Number(a.hasWebsite) - Number(b.hasWebsite));
  const list = businesses.slice(0, 80);

  return respond(200, { success: true, total: list.length, location: geo.label, businesses: list });
};
