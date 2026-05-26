// app/api/zra-proxy/route.js
// Add this file to your cryogen.team Next.js repo
// It will be live at: https://cryogen.team/api/zra-proxy

const ZRA_KEY = '63e32b2550a0742a4aa04923';
const TEAM_ID = '2740';

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function OPTIONS() {
  return new Response(null, { status: 200, headers: CORS });
}

export async function GET() {
  try {
    const upstream = await fetch(
      `https://www.zwiftracing.app/api/clubs/${TEAM_ID}/riders`,
      {
        headers: {
          Authorization: ZRA_KEY,
          'User-Agent':  'CRYOGEN-Club-App/1.0',
          'Accept':      'application/json',
        },
        next: { revalidate: 300 }, // cache 5 mins
      }
    );

    const data = await upstream.json();

    return Response.json(data, {
      status: upstream.status,
      headers: CORS,
    });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 502, headers: CORS });
  }
}
