// Magic MARCeting — lead search (Netlify function)
// POST { city, type }  ->  { success, total, businesses: [...] }  or  { error }
// Data: Geoapify (geocoding + Places). Free plan: 3,000 credits/day, no card.
// The API key lives in Netlify: Site configuration -> Environment variables -> GEOAPIFY_KEY

const HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json'
};

// App business type -> Geoapify categories (exact names from Geoapify's docs)
const CATEGORIES = {
  'restaurant':       'catering.restaurant,catering.cafe,catering.fast_food,catering.bar,catering.pub,catering.ice_cream',
  'salon':            'service.beauty',
  'gym':              'sport.fitness',
  'contractor':       'service.electrician,service.carpenter,service.metal_construction',
  'realtor':          'office.estate_agent,service.estate_agent',
  'retail':           'commercial.clothing',
  'food truck':       'catering.fast_food,catering.food_court',
  'cleaning service': 'service.cleaning',
  'dentist':          'healthcare.dentist',
  'auto repair':      'service.vehicle.repair,service.vehicle.car_wash'
};

const respond = (statusCode, obj) => ({ statusCode, headers: HEADERS, body: JSON.stringify(obj) });

async function getJSON(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: ctrl.signal });
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { /* not JSON */ }
    if (!res.ok) {
      const msg = (data && (data.message || data.error)) || text.slice(0, 120);
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

function friendly(err) {
  if (err.name === 'AbortError') return 'The lead search took too long. Please try again.';
  if (err.status === 401 || err.status === 403) return 'The Geoapify API key is missing or wrong. Check GEOAPIFY_KEY in Netlify.';
  if (err.status === 429) return "Today's free search limit is used up. It resets tomorrow.";
  return 'Search failed: ' + (err.message || 'unknown error');
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') return respond(200, {});
  if (event.httpMethod !== 'POST') return respond(405, { error: 'Use POST with { city, type }' });

  const KEY = process.env.GEOAPIFY_KEY;
  if (!KEY) return respond(200, { error: 'Setup needed: add GEOAPIFY_KEY in Netlify environment variables, then redeploy.' });

  let body;
  try { body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {}); }
  catch (e) { return respond(400, { error: 'Invalid JSON' }); }

  const city = String(body.city || '').trim();
  const type = String(body.type || 'restaurant').trim();
  if (!city) return respond(400, { error: 'Please enter a city.' });
  const categories = CATEGORIES[type] || CATEGORIES['restaurant'];

  try {
    // 1) Find the city
    const geoUrl = `https://api.geoapify.com/v1/geocode/search?text=${encodeURIComponent(city)}&limit=1&format=json&apiKey=${KEY}`;
    const geo = await getJSON(geoUrl, 4000);
    const place = geo && geo.results && geo.results[0];
    if (!place) return respond(200, { error: `Couldn't find "${city}". Try adding the state, like "Lombard, IL".` });
    const { lat, lon } = place;

    // 2) Businesses within ~8 km, nearest first, named ones only
    const placesUrl = `https://api.geoapify.com/v2/places?categories=${categories}` +
      `&conditions=named&filter=circle:${lon},${lat},8000&bias=proximity:${lon},${lat}&limit=100&apiKey=${KEY}`;
    const data = await getJSON(placesUrl, 5000);
    const features = (data && data.features) || [];

    const seen = new Set();
    const businesses = [];
    for (const f of features) {
      const p = f.properties || {};
      const raw = (p.datasource && p.datasource.raw) || {};
      const name = p.name || raw.name;
      if (!name) continue;
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const website = p.website || raw.website || raw['contact:website'] || raw.url || null;
      // Chains (McDonald's, Great Clips...) always have a corporate site, so they aren't real leads
      const isChain = !!(p.brand || raw.brand || raw['brand:wikidata']);
      const phone = (p.contact && p.contact.phone) || raw.phone || raw['contact:phone'] || 'N/A';
      const street = [p.housenumber, p.street].filter(Boolean).join(' ');
      const address = [street, p.city].filter(Boolean).join(', ') || p.address_line2 || city;

      businesses.push({
        name,
        address,
        phone,
        website,
        hasWebsite: !!website || isChain,
        chain: isChain,
        email: (p.contact && p.contact.email) || raw.email || raw['contact:email'] || null,
        instagram: raw['contact:instagram'] || null,
        facebook: raw['contact:facebook'] || null,
        rating: 'N/A',
        categories: type
      });
    }

    businesses.sort((a, b) => Number(a.hasWebsite) - Number(b.hasWebsite));
    return respond(200, { success: true, total: businesses.length, location: place.formatted, businesses });
  } catch (err) {
    return respond(200, { error: friendly(err) });
  }
};
