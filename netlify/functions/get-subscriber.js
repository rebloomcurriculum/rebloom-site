// get-subscriber.js
// Looks up a subscriber by email using service role key (bypasses RLS)

exports.handler = async function(event) {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: 'Method not allowed' };
  }

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { email } = body;
  if (!email) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Email required' }) };
  }

  const res = await fetch(
    `${process.env.SUPABASE_URL}/rest/v1/subscribers?email=eq.${encodeURIComponent(email)}&select=plan,status&limit=1`,
    {
      headers: {
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'Content-Type': 'application/json'
      }
    }
  );

  const data = await res.json();
  console.log('Subscriber lookup for', email, ':', JSON.stringify(data));

  if (!data || data.length === 0) {
    return { statusCode: 404, headers, body: JSON.stringify({ error: 'Not found' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify(data[0]) };
};
