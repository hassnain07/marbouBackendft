/**
 * Generates postman/marbou.postman_collection.json and postman/local.postman_environment.json
 * Run: npm run postman
 */
import fs from 'fs';
import path from 'path';

const BASE = '{{baseUrl}}';
const DEV = '{{devUrl}}';

// ─── helpers ─────────────────────────────────────────────────────────────────

function req(
  name: string,
  method: string,
  url: string,
  body?: unknown,
  prerequest?: string,
  tests?: string,
  headers?: Array<{ key: string; value: string }>,
) {
  return {
    name,
    request: {
      method,
      header: headers ?? [],
      url: { raw: url, host: [url] },
      ...(body ? { body: { mode: 'raw', raw: JSON.stringify(body, null, 2), options: { raw: { language: 'json' } } } } : {}),
    },
    event: [
      ...(prerequest ? [{ listen: 'prerequest', script: { exec: prerequest.split('\n'), type: 'text/javascript' } }] : []),
      ...(tests ? [{ listen: 'test', script: { exec: tests.split('\n'), type: 'text/javascript' } }] : []),
    ],
  };
}

function folder(name: string, items: unknown[], prerequest?: string) {
  return {
    name,
    item: items,
    event: prerequest ? [{ listen: 'prerequest', script: { exec: prerequest.split('\n'), type: 'text/javascript' } }] : [],
  };
}

// ─── Collection-level scripts ─────────────────────────────────────────────────

const collectionPrerequest = `
pm.request.headers.upsert({ key: 'X-Device-Id', value: pm.environment.get('deviceId') || '11111111-1111-4111-8111-111111111111' });
pm.request.headers.upsert({ key: 'Accept-Language', value: 'en' });
const isAdmin = pm.request.url.getPath().includes('/admin/');
const t = pm.environment.get(isAdmin ? 'adminToken' : 'accessToken');
if (t && !pm.request.headers.has('Authorization')) {
  pm.request.headers.add({ key: 'Authorization', value: 'Bearer ' + t });
}
`.trim();

const collectionTests = `
pm.test('no 5xx', () => pm.expect(pm.response.code).to.be.below(500));
pm.test('response time < 1500ms', () => pm.expect(pm.response.responseTime).to.be.below(1500));
if (pm.response.code >= 400) {
  pm.test('error envelope', () => pm.expect(pm.response.json()).to.have.nested.property('error.code'));
}
`.trim();

// ─── Token capture helpers ────────────────────────────────────────────────────

const captureUserTokens = `
const j = pm.response.json();
if (j.accessToken) { pm.environment.set('accessToken', j.accessToken); pm.environment.set('refreshToken', j.refreshToken); }
if (j.user && j.user.id) pm.environment.set('userId', j.user.id);
`.trim();

const captureAdminTokens = `
const j = pm.response.json();
if (j.accessToken) { pm.environment.set('adminToken', j.accessToken); pm.environment.set('adminRefresh', j.refreshToken); }
`.trim();

const captureMfaToken = `
const j = pm.response.json();
if (j.mfaToken) pm.environment.set('mfaToken', j.mfaToken);
`.trim();

// ─── OTP pre-request ─────────────────────────────────────────────────────────

function otpPrerequest(emailVar: string, purposeVar = 'REGISTER') {
  return `
pm.sendRequest({
  url: pm.environment.get('devUrl') + '/last-otp?email=' + pm.environment.get('${emailVar}').toLowerCase() + '&purpose=${purposeVar}',
  method: 'GET'
}, (err, res) => { if (!err && res.json().code) pm.variables.set('otp', res.json().code); });
`.trim();
}

// ─── Folder 00: Health & Config ───────────────────────────────────────────────

const folder00PreReq = `pm.environment.set('runId', Date.now().toString());`;

const f00 = folder('00 Health & Config', [
  req('GET /health', 'GET', `${BASE}/health`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\npm.test('status ok', () => pm.expect(pm.response.json().status).to.equal('ok'));`),
  req('GET /health/ready', 'GET', `${BASE}/health/ready`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));`),
  req('GET /config', 'GET', `${BASE}/config`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\npm.test('has flags', () => pm.expect(pm.response.json()).to.have.property('flags'));\nconst etag = pm.response.headers.get('ETag');\nif (etag) pm.environment.set('configEtag', etag);`),
  req('GET /config 304 [NEG]', 'GET', `${BASE}/config`, undefined, `pm.request.headers.upsert({key:'If-None-Match',value:pm.environment.get('configEtag')});`,
    `pm.test('304 or 200', () => pm.expect([200,304]).to.include(pm.response.code));`),
  req('GET /translations?lang=ar', 'GET', `${BASE}/translations?lang=ar`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));`),
  req('GET /exchange-rate', 'GET', `${BASE}/exchange-rate?base=USD&quote=SDG`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));`),
], folder00PreReq);

// ─── Folder 01: Auth ──────────────────────────────────────────────────────────

const sellerEmail = `seller+{{runId}}@test.com`;
const buyerEmail = `buyer+{{runId}}@test.com`;

const f01 = folder('01 Auth', [
  req('POST /auth/register (seller)', 'POST', `${BASE}/auth/register`,
    { email: sellerEmail, password: 'Password1!', fullName: 'Seller User' }, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\npm.test('has userId', () => pm.expect(pm.response.json()).to.have.property('userId'));`),

  req('POST /auth/register (buyer)', 'POST', `${BASE}/auth/register`,
    { email: buyerEmail, password: 'Password1!', fullName: 'Buyer User' }, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));`),

  req('POST /auth/otp/verify (seller)', 'POST', `${BASE}/auth/otp/verify`,
    { email: sellerEmail, code: '{{otp}}', purpose: 'REGISTER' },
    otpPrerequest('email'),
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\npm.test('has accessToken', () => pm.expect(pm.response.json()).to.have.property('accessToken'));\n${captureUserTokens}`),

  req('POST /auth/otp/verify (buyer)', 'POST', `${BASE}/auth/otp/verify`,
    { email: buyerEmail, code: '{{otp}}', purpose: 'REGISTER' },
    `pm.sendRequest({url:pm.environment.get('devUrl')+'/last-otp?email='+pm.environment.get('buyerEmail').toLowerCase()+'&purpose=REGISTER',method:'GET'},(err,res)=>{if(!err&&res.json().code)pm.variables.set('otp',res.json().code);});`,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\nconst j=pm.response.json();if(j.accessToken){pm.environment.set('buyerToken',j.accessToken);pm.environment.set('buyerRefresh',j.refreshToken);}`),

  req('POST /auth/login', 'POST', `${BASE}/auth/login`,
    { email: sellerEmail, password: 'Password1!', device: { id: '{{deviceId}}', name: 'Postman', os: 'test' } },
    undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\n${captureUserTokens}`),

  req('POST /auth/refresh', 'POST', `${BASE}/auth/refresh`,
    { refreshToken: '{{refreshToken}}' }, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\nconst j=pm.response.json();if(j.accessToken){pm.environment.set('accessToken',j.accessToken);pm.environment.set('refreshToken',j.refreshToken);}`),

  req('GET /auth/otp/channels', 'GET', `${BASE}/auth/otp/channels`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\npm.test('has email', () => pm.expect(pm.response.json()).to.have.property('email'));`),

  req('GET /me/sessions', 'GET', `${BASE}/me/sessions`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\npm.test('is array', () => pm.expect(pm.response.json()).to.be.an('array'));\nconst s=pm.response.json();if(s.length>0)pm.environment.set('sessionId',s[0].id);`),

  req('GET /me/login-events', 'GET', `${BASE}/me/login-events`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));`),

  req('POST /auth/password/forgot', 'POST', `${BASE}/auth/password/forgot`,
    { email: sellerEmail }, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));`),

  req('POST /auth/social/google (mock)', 'POST', `${BASE}/auth/social/google`,
    { idToken: `mock:social+{{runId}}@test.com:Social User`, device: {} }, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\npm.test('has accessToken', () => pm.expect(pm.response.json()).to.have.property('accessToken'));`),

  // NEG cases
  req('[NEG] register weak password', 'POST', `${BASE}/auth/register`,
    { email: `neg+{{runId}}@test.com`, password: 'weak', fullName: 'A' }, undefined,
    `pm.test('status 400', () => pm.expect(pm.response.code).to.equal(400));\npm.test('WEAK_PASSWORD', () => pm.expect(pm.response.json().error.code).to.equal('WEAK_PASSWORD'));`),

  req('[NEG] login wrong password x5 then lockout', 'POST', `${BASE}/auth/login`,
    { email: sellerEmail, password: 'WrongPass1', device: {} }, `
for(let i=0;i<5;i++){
  pm.sendRequest({url:pm.environment.get('baseUrl')+'/auth/login',method:'POST',header:[{key:'Content-Type',value:'application/json'}],body:{mode:'raw',raw:JSON.stringify({email:pm.environment.get('email')||'${sellerEmail}',password:'WrongPass1',device:{}})}},()=>{});
}
`.trim(),
    `pm.test('429 or 401', () => pm.expect([401,429]).to.include(pm.response.code));`),

  req('[NEG] refresh token reuse', 'POST', `${BASE}/auth/refresh`,
    { refreshToken: 'invalid-token-reuse-test' }, undefined,
    `pm.test('status 401', () => pm.expect(pm.response.code).to.equal(401));`),

  req('[NEG] expired bearer -> 401', 'GET', `${BASE}/me`, undefined, `pm.request.headers.upsert({key:'Authorization',value:'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4IiwiZXhwIjoxfQ.invalid'});`,
    `pm.test('status 401', () => pm.expect(pm.response.code).to.equal(401));`),

  req('[NEG] otp/request no email', 'POST', `${BASE}/auth/otp/request`,
    { purpose: 'REGISTER' }, undefined,
    `pm.test('status 400', () => pm.expect(pm.response.code).to.equal(400));`),
]);

// ─── Folder 02: Profile & Capabilities ───────────────────────────────────────

const f02 = folder('02 Profile & Capabilities', [
  req('GET /me', 'GET', `${BASE}/me`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\npm.test('has email', () => pm.expect(pm.response.json()).to.have.property('email'));`),

  req('PATCH /me', 'PATCH', `${BASE}/me`,
    { fullName: 'Updated Seller', bio: 'Test bio', language: 'en' }, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\npm.test('name updated', () => pm.expect(pm.response.json().fullName).to.equal('Updated Seller'));`),

  req('GET /me/capabilities', 'GET', `${BASE}/me/capabilities`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));`),

  req('POST /me/capabilities (SELLER)', 'POST', `${BASE}/me/capabilities`,
    { capability: 'SELLER' }, undefined,
    `pm.test('200 or 409', () => pm.expect([200,409]).to.include(pm.response.code));`),

  req('GET /me/notification-preferences', 'GET', `${BASE}/me/notification-preferences`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));`),

  req('GET /me/blocks', 'GET', `${BASE}/me/blocks`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));`),

  req('GET /users/:id (public)', 'GET', `${BASE}/users/{{userId}}`, undefined, undefined,
    `pm.test('200 or 404', () => pm.expect([200,404]).to.include(pm.response.code));`),

  // NEG
  req('[NEG] GET /me no token', 'GET', `${BASE}/me`, undefined,
    `pm.request.headers.remove('Authorization');`,
    `pm.test('status 401', () => pm.expect(pm.response.code).to.equal(401));`),

  req('[NEG] customer token on /admin/me', 'GET', `${BASE}/admin/me`, undefined, undefined,
    `pm.test('status 401', () => pm.expect(pm.response.code).to.equal(401));`),
]);

// ─── Folder 03: Admin Login (2FA) ─────────────────────────────────────────────

const f03 = folder('03 Admin Login (2FA)', [
  req('POST /admin/auth/login', 'POST', `${BASE}/admin/auth/login`,
    { email: 'admin@marbou.test', password: 'Admin#12345' }, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\npm.test('has mfaToken', () => pm.expect(pm.response.json()).to.have.property('mfaToken'));\n${captureMfaToken}`),

  req('POST /admin/auth/verify-2fa', 'POST', `${BASE}/admin/auth/verify-2fa`,
    { mfaToken: '{{mfaToken}}', code: '000000' }, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\npm.test('has accessToken', () => pm.expect(pm.response.json()).to.have.property('accessToken'));\n${captureAdminTokens}`),

  req('GET /admin/me', 'GET', `${BASE}/admin/me`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\npm.test('has role', () => pm.expect(pm.response.json()).to.have.property('role'));`),

  req('GET /admin/settings', 'GET', `${BASE}/admin/settings`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));`),

  req('GET /admin/audit-logs', 'GET', `${BASE}/admin/audit-logs`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\npm.test('has data', () => pm.expect(pm.response.json()).to.have.property('data'));`),

  req('GET /admin/audit-logs/verify', 'GET', `${BASE}/admin/audit-logs/verify`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\npm.test('chain ok', () => pm.expect(pm.response.json().ok).to.equal(true));`),

  req('GET /admin/admins', 'GET', `${BASE}/admin/admins`, undefined, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));`),

  req('POST /admin/auth/refresh', 'POST', `${BASE}/admin/auth/refresh`,
    { refreshToken: '{{adminRefresh}}' }, undefined,
    `pm.test('status 200', () => pm.expect(pm.response.code).to.equal(200));\nconst j=pm.response.json();if(j.accessToken){pm.environment.set('adminToken',j.accessToken);pm.environment.set('adminRefresh',j.refreshToken);}`),

  // NEG
  req('[NEG] admin login wrong password', 'POST', `${BASE}/admin/auth/login`,
    { email: 'admin@marbou.test', password: 'WrongPass1' }, undefined,
    `pm.test('status 401', () => pm.expect(pm.response.code).to.equal(401));`),

  req('[NEG] admin verify-2fa wrong code', 'POST', `${BASE}/admin/auth/verify-2fa`,
    { mfaToken: '{{mfaToken}}', code: '999999' }, undefined,
    `pm.test('400 or 400', () => pm.expect(pm.response.code).to.equal(400));`),

  req('[NEG] moderator PATCH settings -> 403', 'PATCH', `${BASE}/admin/settings/flags.otp.email`,
    { value: true },
    `pm.request.headers.upsert({key:'Authorization',value:'Bearer MODERATOR_TOKEN_PLACEHOLDER'});`,
    `pm.test('401 or 403', () => pm.expect([401,403]).to.include(pm.response.code));`),
]);

// ─── Assemble collection ──────────────────────────────────────────────────────

const collection = {
  info: {
    name: 'MARBOU API - Slice 1',
    schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
  },
  event: [
    { listen: 'prerequest', script: { exec: collectionPrerequest.split('\n'), type: 'text/javascript' } },
    { listen: 'test', script: { exec: collectionTests.split('\n'), type: 'text/javascript' } },
  ],
  variable: [
    { key: 'baseUrl', value: 'http://localhost:4000/api/v1' },
    { key: 'devUrl', value: 'http://localhost:4000/dev' },
  ],
  item: [f00, f01, f02, f03],
};

// ─── Environment ─────────────────────────────────────────────────────────────

const environment = {
  name: 'MARBOU Local',
  values: [
    { key: 'baseUrl', value: 'http://localhost:4000/api/v1', enabled: true },
    { key: 'devUrl', value: 'http://localhost:4000/dev', enabled: true },
    { key: 'deviceId', value: '11111111-1111-4111-8111-111111111111', enabled: true },
    { key: 'email', value: '', enabled: true },
    { key: 'buyerEmail', value: '', enabled: true },
    { key: 'password', value: 'Password1!', enabled: true },
    { key: 'adminEmail', value: 'admin@marbou.test', enabled: true },
    { key: 'adminPassword', value: 'Admin#12345', enabled: true },
    { key: 'accessToken', value: '', enabled: true },
    { key: 'refreshToken', value: '', enabled: true },
    { key: 'buyerToken', value: '', enabled: true },
    { key: 'buyerRefresh', value: '', enabled: true },
    { key: 'adminToken', value: '', enabled: true },
    { key: 'adminRefresh', value: '', enabled: true },
    { key: 'mfaToken', value: '', enabled: true },
    { key: 'userId', value: '', enabled: true },
    { key: 'sessionId', value: '', enabled: true },
    { key: 'runId', value: '', enabled: true },
    { key: 'categoryId', value: '', enabled: true },
    { key: 'mediaId', value: '', enabled: true },
    { key: 'listingId', value: '', enabled: true },
    { key: 'threadId', value: '', enabled: true },
    { key: 'configEtag', value: '', enabled: true },
    { key: 'otp', value: '', enabled: true },
  ],
};

// ─── Write files ─────────────────────────────────────────────────────────────

const outDir = path.resolve(__dirname, '../postman');
if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

fs.writeFileSync(path.join(outDir, 'marbou.postman_collection.json'), JSON.stringify(collection, null, 2));
fs.writeFileSync(path.join(outDir, 'local.postman_environment.json'), JSON.stringify(environment, null, 2));

console.log('✅ Postman collection and environment written to postman/');
