import 'dotenv/config';
import express from 'express';
import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import { ConfidentialClientApplication } from '@azure/msal-node';

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static('.'));

const port = Number(process.env.PORT || 3000);
const supabaseAdmin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { autoRefreshToken: false, persistSession: false }
});
const supabasePublic = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

function keyBuffer() {
  const raw = process.env.APP_ENCRYPTION_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(raw)) throw new Error('APP_ENCRYPTION_KEY must be 64 hex characters');
  return Buffer.from(raw, 'hex');
}
function encrypt(value) {
  if (!value) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyBuffer(), iv);
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map(b => b.toString('base64url')).join('.');
}
function decrypt(value) {
  if (!value) return null;
  const [ivS, tagS, dataS] = value.split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyBuffer(), Buffer.from(ivS, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagS, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(dataS, 'base64url')), decipher.final()]).toString('utf8');
}

async function requireUser(req, res, next) {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing bearer token' });
    const { data, error } = await supabasePublic.auth.getUser(token);
    if (error || !data.user) return res.status(401).json({ error: 'Invalid session' });
    req.user = data.user;
    req.accessToken = token;
    next();
  } catch (e) { res.status(401).json({ error: e.message }); }
}

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.get('/api/config', (_req, res) => res.json({
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  appBaseUrl: process.env.APP_BASE_URL || ''
}));

app.get('/api/integrations', requireUser, async (req, res) => {
  const { data, error } = await supabaseAdmin.from('integrations').select('provider,account_email,scopes,expires_at,updated_at').eq('user_id', req.user.id);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ integrations: data || [] });
});

function googleClient() {
  return new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, process.env.GOOGLE_REDIRECT_URI);
}
app.post('/api/oauth/google/start', requireUser, (req, res) => {
  const oauth = googleClient();
  const state = Buffer.from(JSON.stringify({ uid: req.user.id }), 'utf8').toString('base64url');
  const url = oauth.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['openid','email','profile','https://www.googleapis.com/auth/gmail.readonly','https://www.googleapis.com/auth/calendar.readonly'],
    state
  });
  res.json({ url });
});

app.get('/api/oauth/google/callback', async (req, res) => {
  try {
    const payload = JSON.parse(Buffer.from(req.query.state, 'base64url').toString('utf8'));
    const oauth = googleClient();
    const { tokens } = await oauth.getToken(req.query.code);
    oauth.setCredentials(tokens);
    const oauth2 = google.oauth2({ version: 'v2', auth: oauth });
    const { data: profile } = await oauth2.userinfo.get();
    const row = {
      user_id: payload.uid,
      provider: 'google',
      account_email: profile.email || null,
      access_token_enc: encrypt(tokens.access_token),
      refresh_token_enc: encrypt(tokens.refresh_token),
      expires_at: tokens.expiry_date ? new Date(tokens.expiry_date).toISOString() : null,
      scopes: tokens.scope || null
    };
    const { error } = await supabaseAdmin.from('integrations').upsert(row, { onConflict: 'user_id,provider' });
    if (error) throw error;
    res.redirect('/?connected=google');
  } catch (e) { res.status(400).send(`Google connection failed: ${e.message}`); }
});

async function microsoftClient() {
  return new ConfidentialClientApplication({
    auth: {
      clientId: process.env.MICROSOFT_CLIENT_ID,
      authority: `https://login.microsoftonline.com/${process.env.MICROSOFT_TENANT || 'common'}`,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET
    }
  });
}
app.post('/api/oauth/microsoft/start', requireUser, async (req, res) => {
  const cca = await microsoftClient();
  const state = Buffer.from(JSON.stringify({ uid: req.user.id }), 'utf8').toString('base64url');
  const url = await cca.getAuthCodeUrl({
    scopes: ['openid','profile','email','offline_access','User.Read','Mail.Read','Calendars.Read'],
    redirectUri: process.env.MICROSOFT_REDIRECT_URI,
    state
  });
  res.json({ url });
});

app.get('/api/oauth/microsoft/callback', async (req, res) => {
  try {
    const payload = JSON.parse(Buffer.from(req.query.state, 'base64url').toString('utf8'));
    const cca = await microsoftClient();
    const result = await cca.acquireTokenByCode({
      code: req.query.code,
      scopes: ['openid','profile','email','offline_access','User.Read','Mail.Read','Calendars.Read'],
      redirectUri: process.env.MICROSOFT_REDIRECT_URI
    });
    const tokenCache = cca.getTokenCache().serialize();
    const row = {
      user_id: payload.uid,
      provider: 'microsoft',
      account_email: result.account?.username || null,
      access_token_enc: encrypt(result.accessToken),
      refresh_token_enc: encrypt(tokenCache),
      expires_at: result.expiresOn?.toISOString() || null,
      scopes: result.scopes?.join(' ') || null
    };
    const { error } = await supabaseAdmin.from('integrations').upsert(row, { onConflict: 'user_id,provider' });
    if (error) throw error;
    res.redirect('/?connected=microsoft');
  } catch (e) { res.status(400).send(`Microsoft connection failed: ${e.message}`); }
});

async function getIntegration(uid, provider) {
  const { data, error } = await supabaseAdmin.from('integrations').select('*').eq('user_id', uid).eq('provider', provider).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error(`No ${provider} integration connected`);
  return data;
}

app.get('/api/google/email', requireUser, async (req, res) => {
  try {
    const row = await getIntegration(req.user.id, 'google');
    const oauth = googleClient();
    oauth.setCredentials({ access_token: decrypt(row.access_token_enc), refresh_token: decrypt(row.refresh_token_enc) });
    const gmail = google.gmail({ version: 'v1', auth: oauth });
    const list = await gmail.users.messages.list({ userId: 'me', maxResults: 20 });
    const ids = list.data.messages || [];
    const messages = await Promise.all(ids.map(async m => {
      const r = await gmail.users.messages.get({ userId: 'me', id: m.id, format: 'metadata', metadataHeaders: ['Subject','From','To','Date'] });
      const headers = Object.fromEntries((r.data.payload?.headers || []).map(h => [h.name.toLowerCase(), h.value]));
      return { id: m.id, subject: headers.subject || '(no subject)', from: headers.from || '', to: headers.to || '', date: headers.date || '', snippet: r.data.snippet || '' };
    }));
    res.json({ messages });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/google/calendar', requireUser, async (req, res) => {
  try {
    const row = await getIntegration(req.user.id, 'google');
    const oauth = googleClient();
    oauth.setCredentials({ access_token: decrypt(row.access_token_enc), refresh_token: decrypt(row.refresh_token_enc) });
    const calendar = google.calendar({ version: 'v3', auth: oauth });
    const result = await calendar.events.list({ calendarId: 'primary', maxResults: 20, singleEvents: true, orderBy: 'startTime', timeMin: new Date().toISOString() });
    res.json({ events: result.data.items || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

async function getMicrosoftAccessToken(row) {
  const cca = await microsoftClient();
  if (row.refresh_token_enc) {
    try {
      const cache = cca.getTokenCache();
      cache.deserialize(decrypt(row.refresh_token_enc));
      const accounts = await cache.getAllAccounts();
      if (accounts[0]) {
        const silent = await cca.acquireTokenSilent({ account: accounts[0], scopes: ['User.Read','Mail.Read','Calendars.Read'] });
        if (silent?.accessToken) return silent.accessToken;
      }
    } catch (_) {}
  }
  return decrypt(row.access_token_enc);
}

app.get('/api/microsoft/email', requireUser, async (req, res) => {
  try {
    const row = await getIntegration(req.user.id, 'microsoft');
    const token = await getMicrosoftAccessToken(row);
    const r = await fetch('https://graph.microsoft.com/v1.0/me/messages?$top=20&$select=id,subject,from,toRecipients,receivedDateTime,bodyPreview', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    res.json({ messages: data.value || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/microsoft/calendar', requireUser, async (req, res) => {
  try {
    const row = await getIntegration(req.user.id, 'microsoft');
    const token = await getMicrosoftAccessToken(row);
    const r = await fetch('https://graph.microsoft.com/v1.0/me/events?$top=20&$orderby=start/dateTime', { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) throw new Error(await r.text());
    const data = await r.json();
    res.json({ events: data.value || [] });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use((_req, res) => res.sendFile(process.cwd() + '/index.html'));
app.listen(port, () => console.log(`Client Hub running on http://localhost:${port}`));
