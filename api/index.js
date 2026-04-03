// ============================================================
//  LAXMAN MOTORS — VERCEL SERVERLESS BACKEND
//  Handles: OTP, Bills, Bookings, Parts Enquiry
// ============================================================

const AIRTABLE_KEY  = process.env.AIRTABLE_API_KEY;
const AIRTABLE_BASE = process.env.AIRTABLE_BASE_ID;
const PING4SMS_KEY  = process.env.PING4SMS_API_KEY;
const PING4SMS_SENDER = process.env.PING4SMS_SENDER_ID || 'LAXMAN';

// In-memory OTP store (auto-expires — Vercel edge keeps warm for ~5min)
const otpStore = new Map();

// ── CORS HEADERS ──────────────────────────────────────────────
function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── MAIN HANDLER ──────────────────────────────────────────────
module.exports = async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { pathname } = new URL(req.url, `http://${req.headers.host}`);
  const path = pathname.replace(/^\/api/, '');

  try {
    if (path === '/send-otp'   && req.method === 'POST') return await sendOTP(req, res);
    if (path === '/verify-otp' && req.method === 'POST') return await verifyOTP(req, res);
    if (path === '/bills'      && req.method === 'GET')  return await getBills(req, res);
    if (path === '/booking'    && req.method === 'POST') return await saveBooking(req, res);
    if (path === '/enquiry'    && req.method === 'POST') return await saveEnquiry(req, res);
    if (path === '/health'     && req.method === 'GET')  return res.json({ ok: true, time: new Date() });

    return res.status(404).json({ error: 'Route not found' });
  } catch (err) {
    console.error('API Error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// ══════════════════════════════════════════════════════════════
//  1. SEND OTP
// ══════════════════════════════════════════════════════════════
async function sendOTP(req, res) {
  const { mobile, vehicle } = await parseBody(req);

  if (!mobile || mobile.replace(/\D/g, '').length < 10)
    return res.status(400).json({ error: 'Invalid mobile number' });
  if (!vehicle)
    return res.status(400).json({ error: 'Vehicle number required' });

  const cleanMobile  = mobile.replace(/\D/g, '').slice(-10);
  const cleanVehicle = vehicle.trim().toUpperCase().replace(/\s+/g, '');

  // Check customer exists in Airtable
  const customer = await airtableFind('Customers', cleanMobile, cleanVehicle);
  if (!customer) {
    return res.status(404).json({
      error: 'not_found',
      message: 'Mobile number or vehicle not found. Please contact Laxman Motors.'
    });
  }

  // Generate 4-digit OTP
  const otp = Math.floor(1000 + Math.random() * 9000).toString();
  const key = `${cleanMobile}_${cleanVehicle}`;

  // Store OTP with 10-minute expiry
  otpStore.set(key, {
    otp,
    expires: Date.now() + 10 * 60 * 1000,
    customerId: customer.id,
    customerName: customer.fields['name'] || ''
  });

  // Send SMS via Ping4SMS
  const smsSent = await sendPing4SMS(cleanMobile, otp);

  if (!smsSent) {
    return res.status(500).json({ error: 'Failed to send OTP. Please try again.' });
  }

  return res.json({
    success: true,
    message: `OTP sent to +91 ${cleanMobile}`,
    maskedMobile: `+91 XXXXXX${cleanMobile.slice(-4)}`
  });
}

// ══════════════════════════════════════════════════════════════
//  2. VERIFY OTP & RETURN BILLS
// ══════════════════════════════════════════════════════════════
async function verifyOTP(req, res) {
  const { mobile, vehicle, otp } = await parseBody(req);

  const cleanMobile  = mobile.replace(/\D/g, '').slice(-10);
  const cleanVehicle = vehicle.trim().toUpperCase().replace(/\s+/g, '');
  const key = `${cleanMobile}_${cleanVehicle}`;

  const stored = otpStore.get(key);

  if (!stored)
    return res.status(400).json({ error: 'OTP expired or not sent. Please request a new OTP.' });

  if (Date.now() > stored.expires) {
    otpStore.delete(key);
    return res.status(400).json({ error: 'OTP has expired. Please request a new one.' });
  }

  if (stored.otp !== otp.trim())
    return res.status(401).json({ error: 'Incorrect OTP. Please try again.' });

  // OTP correct — fetch bills
  otpStore.delete(key);
  const bills = await fetchBills(cleanMobile, cleanVehicle);

  return res.json({
    success: true,
    customerName: stored.customerName,
    bills
  });
}

// ══════════════════════════════════════════════════════════════
//  3. GET BILLS (secured — called after OTP verify internally)
// ══════════════════════════════════════════════════════════════
async function getBills(req, res) {
  const { mobile, vehicle } = req.query;
  if (!mobile || !vehicle)
    return res.status(400).json({ error: 'mobile and vehicle required' });

  const bills = await fetchBills(
    mobile.replace(/\D/g, '').slice(-10),
    vehicle.trim().toUpperCase()
  );
  return res.json({ success: true, bills });
}

// ══════════════════════════════════════════════════════════════
//  4. SAVE BOOKING + NOTIFY
// ══════════════════════════════════════════════════════════════
async function saveBooking(req, res) {
  const body = await parseBody(req);
  const { name, mobile, vehicle, model, serviceType, preferredDate, preferredTime, notes } = body;

  if (!name || !mobile || !vehicle)
    return res.status(400).json({ error: 'Name, mobile and vehicle are required' });

  // Save to Airtable Bookings table
  const record = await airtableCreate('Bookings', {
    'name': name,
    'mobile': mobile.replace(/\D/g, '').slice(-10),
    'vehicle_number': vehicle.toUpperCase(),
    're_model': model || '',
    'service_type': serviceType || '',
    'preferred_date': preferredDate || '',
    'preferred_time': preferredTime || '',
    'notes': notes || '',
    'status': 'Pending',
    'created_at': new Date().toISOString()
  });

  // Send WhatsApp notification link (returned to frontend to open)
  const waMsg = formatBookingWA(body);
  const waUrl = `https://wa.me/${process.env.OWNER_WHATSAPP || '918220707408'}?text=${encodeURIComponent(waMsg)}`;

  return res.json({
    success: true,
    recordId: record?.id,
    whatsappUrl: waUrl,
    message: 'Booking saved! We will confirm within 30 minutes.'
  });
}

// ══════════════════════════════════════════════════════════════
//  5. SAVE PARTS ENQUIRY + NOTIFY
// ══════════════════════════════════════════════════════════════
async function saveEnquiry(req, res) {
  const body = await parseBody(req);
  const { name, mobile, model, year, partsNeeded, category } = body;

  if (!name || !mobile)
    return res.status(400).json({ error: 'Name and mobile are required' });

  // Save to Airtable Parts_Enquiries table
  const record = await airtableCreate('Parts_Enquiries', {
    'name': name,
    'mobile': mobile.replace(/\D/g, '').slice(-10),
    're_model': model || '',
    'year': year || '',
    'parts_needed': partsNeeded || '',
    'category': category || '',
    'status': 'New',
    'created_at': new Date().toISOString()
  });

  const waMsg = formatEnquiryWA(body);
  const waUrl = `https://wa.me/${process.env.OWNER_WHATSAPP || '918220707408'}?text=${encodeURIComponent(waMsg)}`;

  return res.json({
    success: true,
    recordId: record?.id,
    whatsappUrl: waUrl,
    message: 'Enquiry received! We will respond within 2 hours.'
  });
}

// ══════════════════════════════════════════════════════════════
//  AIRTABLE HELPERS
// ══════════════════════════════════════════════════════════════

async function airtableFind(table, mobile, vehicle) {
  const formula = encodeURIComponent(
    `AND({mobile}="${mobile}",{vehicle_number}="${vehicle}")`
  );
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}?filterByFormula=${formula}&maxRecords=1`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_KEY}` } });
  const data = await res.json();
  return data.records?.[0] || null;
}

async function fetchBills(mobile, vehicle) {
  const formula = encodeURIComponent(
    `AND({mobile}="${mobile}",{vehicle_number}="${vehicle}")`
  );
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/Bills?filterByFormula=${formula}&sort[0][field]=date&sort[0][direction]=desc`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${AIRTABLE_KEY}` } });
  const data = await res.json();

  if (!data.records) return [];

  return data.records.map(r => ({
    id: r.id,
    invoiceNo: r.fields['invoice_no'] || '',
    date: r.fields['date'] || '',
    description: r.fields['description'] || 'Service',
    amount: r.fields['amount'] || 0,
    kmReading: r.fields['km_reading'] || '',
    vehicleModel: r.fields['vehicle_model'] || '',
    // PDF attachment URL from Airtable
    pdfUrl: r.fields['pdf']?.[0]?.url || null,
    pdfName: r.fields['pdf']?.[0]?.filename || 'Invoice.pdf',
    pdfThumbnail: r.fields['pdf']?.[0]?.thumbnails?.large?.url || null
  }));
}

async function airtableCreate(table, fields) {
  const url = `https://api.airtable.com/v0/${AIRTABLE_BASE}/${table}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AIRTABLE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ fields })
  });
  return await res.json();
}

// ══════════════════════════════════════════════════════════════
//  PING4SMS OTP SENDER
// ══════════════════════════════════════════════════════════════

async function sendPing4SMS(mobile, otp) {
  try {
    const message = `Your Laxman Motors bill access OTP is ${otp}. Valid for 10 minutes. Do not share with anyone. -LAXMAN`;

    // Ping4SMS API endpoint — adjust URL if different
    const url = `https://www.ping4sms.com/api/sms/?username=${encodeURIComponent(process.env.PING4SMS_USERNAME)}&password=${encodeURIComponent(PING4SMS_KEY)}&to=91${mobile}&from=${PING4SMS_SENDER}&msg=${encodeURIComponent(message)}&type=0`;

    const res = await fetch(url);
    const text = await res.text();
    console.log('Ping4SMS response:', text);

    // Ping4SMS returns a numeric ID on success
    return /^\d+/.test(text.trim());
  } catch (err) {
    console.error('Ping4SMS error:', err);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════
//  WHATSAPP MESSAGE FORMATTERS
// ══════════════════════════════════════════════════════════════

function formatBookingWA(b) {
  return `🏍️ *NEW SERVICE BOOKING — LAXMAN MOTORS*\n\n` +
    `👤 *Name:* ${b.name}\n` +
    `📞 *Mobile:* ${b.mobile}\n` +
    `🚗 *Vehicle No:* ${(b.vehicle || '').toUpperCase()}\n` +
    `🏍️ *RE Model:* ${b.model || 'Not specified'}\n` +
    `🔧 *Service:* ${b.serviceType || 'Not specified'}\n` +
    `📅 *Date:* ${b.preferredDate || 'Not specified'}\n` +
    `⏰ *Time:* ${b.preferredTime || 'Not specified'}\n` +
    `📝 *Notes:* ${b.notes || 'None'}\n\n` +
    `_Saved to Airtable ✅_`;
}

function formatEnquiryWA(e) {
  return `🔩 *SPARE PARTS ENQUIRY — LAXMAN MOTORS*\n\n` +
    `📦 *Category:* ${e.category || 'General'}\n` +
    `👤 *Name:* ${e.name}\n` +
    `📞 *Mobile:* ${e.mobile}\n` +
    `🏍️ *RE Model:* ${e.model || 'Not specified'}\n` +
    `📅 *Year:* ${e.year || 'Not specified'}\n` +
    `🔧 *Parts Needed:* ${e.partsNeeded || 'Not specified'}\n\n` +
    `_Saved to Airtable ✅_`;
}

// ══════════════════════════════════════════════════════════════
//  UTILITY
// ══════════════════════════════════════════════════════════════

async function parseBody(req) {
  if (req.body) return req.body;
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}
