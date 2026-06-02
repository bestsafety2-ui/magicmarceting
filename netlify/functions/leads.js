const https = require('https');

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  let body = {};
  try {
    body = typeof event.body === 'string' ? JSON.parse(event.body) : (event.body || {});
  } catch(e) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) };
  }

  const { city, type } = body;
  if (!city) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing city' }) };

  const typeMap = {
    'restaurant': 'amenity=restaurant',
    'salon': 'shop=hairdresser',
    'gym': 'leisure=fitness_centre',
    'contractor': 'craft=construction',
    'realtor': 'office=estate_agent',
    'retail': 'shop=clothes',
    'food truck': 'amenity=fast_food',
    'cleaning service': 'shop=cleaning',
    'dentist': 'amenity=dentist',
    'auto repair': 'shop=car_repair'
  };

  const osmTag = typeMap[type] || 'amenity=restaurant';
  const [tagKey, tagVal] = osmTag.split('=');

  const query = `[out:json][timeout:30];area[name="${city}"]->.a;(node["${tagKey}"="${tagVal}"](area.a);way["${tagKey}"="${tagVal}"](area.a););out body 40;`;
  const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`;

  try {
    const result = await new Promise((resolve, reject) => {
      https.get(url, { headers: { 'User-Agent': 'MagicMARCeting/1.0' } }, (res) => {
        let raw = '';
        res.on('data', chunk => raw += chunk);
        res.on('end', () => {
          try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
          catch(e) { resolve({ status: res.statusCode, data: { raw: raw.substring(0, 300) } }); }
        });
      }).on('error', reject);
    });

    if (result.status !== 200 || !result.data.elements) {
      return { statusCode: 200, headers, body: JSON.stringify({
        error: `Search failed: ${JSON.stringify(result.data).substring(0, 200)}`
      })};
    }

    const seen = new Set();
    const businesses = [];

    for (const el of result.data.elements) {
      const tags = el.tags || {};
      const name = tags.name;
      if (!name || seen.has(name)) continue;
      seen.add(name);

      const website = tags.website || tags['contact:website'] || null;
      const phone = tags.phone || tags['contact:phone'] || 'N/A';
      const addr = [tags['addr:housenumber'], tags['addr:street'], tags['addr:city'] || city].filter(Boolean).join(' ');

      businesses.push({ name, address: addr || city, phone, website, hasWebsite: !!website, rating: 'N/A', categories: type });
      if (businesses.length >= 30) break;
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, total: businesses.length, businesses }) };

  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
