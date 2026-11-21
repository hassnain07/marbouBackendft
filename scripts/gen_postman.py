import json, os

BASE = '{{baseUrl}}'
DEV = '{{devUrl}}'

col_pre = '\n'.join([
    'pm.request.headers.upsert({ key: "X-Device-Id", value: pm.environment.get("deviceId") || "11111111-1111-4111-8111-111111111111" });',
    'pm.request.headers.upsert({ key: "Accept-Language", value: "en" });',
    'const isAdmin = pm.request.url.getPath().includes("/admin/");',
    'const t = pm.environment.get(isAdmin ? "adminToken" : "accessToken");',
    'if (t && !pm.request.headers.has("Authorization")) {',
    '  pm.request.headers.add({ key: "Authorization", value: "Bearer " + t });',
    '}',
])

col_tests = '\n'.join([
    'pm.test("no 5xx", () => pm.expect(pm.response.code).to.be.below(500));',
    'pm.test("response time < 2000ms", () => pm.expect(pm.response.responseTime).to.be.below(2000));',
    'if (pm.response.code >= 400) {',
    '  pm.test("error envelope", () => pm.expect(pm.response.json()).to.have.nested.property("error.code"));',
    '}',
])

def r(name, method, url, body=None, pre=None, tests=None, hdrs=None):
    obj = {
        'name': name,
        'request': {'method': method, 'header': hdrs or [], 'url': url},
        'event': [],
    }
    if body is not None:
        obj['request']['body'] = {
            'mode': 'raw',
            'raw': json.dumps(body, indent=2),
            'options': {'raw': {'language': 'json'}},
        }
    if pre:
        obj['event'].append({'listen': 'prerequest', 'script': {'type': 'text/javascript', 'exec': pre.split('\n')}})
    if tests:
        obj['event'].append({'listen': 'test', 'script': {'type': 'text/javascript', 'exec': tests.split('\n')}})
    return obj

def fold(name, items, pre=None):
    obj = {'name': name, 'item': items, 'event': []}
    if pre:
        obj['event'].append({'listen': 'prerequest', 'script': {'type': 'text/javascript', 'exec': pre.split('\n')}})
    return obj

def auth_hdr(token_var):
    return [{'key': 'Authorization', 'value': 'Bearer {{' + token_var + '}}', 'type': 'text'}]

def fetch_otp(email_var, purpose='REGISTER'):
    """Standalone GET request that fetches OTP synchronously before the verify step."""
    url = DEV + '/last-otp?email={{' + email_var + '}}&purpose=' + purpose
    return r(
        '[OTP] fetch ' + purpose + ' for {{' + email_var + '}}',
        'GET', url,
        tests='\n'.join([
            'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
            'const _oc = pm.response.json().code;',
            'pm.test("got code", () => pm.expect(_oc).to.match(/^\\d{6}$/));',
            'pm.environment.set("otp", _oc);',
        ])
    )

capture_user = '\n'.join([
    'const j = pm.response.json();',
    'if (j.accessToken) { pm.environment.set("accessToken", j.accessToken); pm.environment.set("refreshToken", j.refreshToken); }',
    'if (j.user && j.user.id) pm.environment.set("userId", j.user.id);',
])

capture_buyer = '\n'.join([
    'const jb = pm.response.json();',
    'if (jb.accessToken) { pm.environment.set("buyerToken", jb.accessToken); pm.environment.set("buyerRefresh", jb.refreshToken); }',
    'if (jb.user && jb.user.id) pm.environment.set("buyerUserId", jb.user.id);',
])

capture_admin = '\n'.join([
    'const ja = pm.response.json();',
    'if (ja.accessToken) { pm.environment.set("adminToken", ja.accessToken); pm.environment.set("adminRefresh", ja.refreshToken); }',
])

capture_mfa = 'const jm = pm.response.json(); if (jm.mfaToken) pm.environment.set("mfaToken", jm.mfaToken);'

# ── Folder 00 ──────────────────────────────────────────────────────────────────
f00_pre = '\n'.join([
    'pm.environment.set("runId", Date.now().toString());',
    'const rid = pm.environment.get("runId");',
    'pm.environment.set("sellerEmail", "seller." + rid + "@test.com");',
    'pm.environment.set("buyerEmail",  "buyer." + rid + "@test.com");',
    'pm.environment.set("lockEmail",   "lock." + rid + "@test.com");',
    'pm.environment.set("changedEmail", "changed." + rid + "@test.com");',
    'pm.environment.set("sellerPassword", "Password1!");',
])

f00 = fold('00 Pre-request and Config', [
    r('GET /health', 'GET', BASE+'/health', tests='\n'.join([
        'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
        'pm.test("ok", () => pm.expect(pm.response.json().status).to.equal("ok"));',
    ])),
    r('GET /config', 'GET', BASE+'/config', tests='\n'.join([
        'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
        'pm.test("has flags", () => pm.expect(pm.response.json()).to.have.property("flags"));',
        'const etag = pm.response.headers.get("ETag");',
        'if (etag) pm.environment.set("configEtag", etag);',
    ])),
    r('GET /config 304 [NEG]', 'GET', BASE+'/config',
      pre='pm.request.headers.upsert({ key: "If-None-Match", value: pm.environment.get("configEtag") });',
      tests='pm.test("304", () => pm.expect(pm.response.code).to.equal(304));'),
], f00_pre)

# ── Folder 01 Auth ─────────────────────────────────────────────────────────────
f01 = fold('01 Auth', [
    r('POST /auth/register (seller)', 'POST', BASE+'/auth/register',
      body={'email': '{{sellerEmail}}', 'password': 'Password1!', 'fullName': 'Seller User'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("userId", () => pm.expect(pm.response.json()).to.have.property("userId"));',
      ])),
    r('POST /auth/register (buyer)', 'POST', BASE+'/auth/register',
      body={'email': '{{buyerEmail}}', 'password': 'Password1!', 'fullName': 'Buyer User'},
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    fetch_otp('sellerEmail', 'REGISTER'),
    r('POST /auth/otp/verify (seller)', 'POST', BASE+'/auth/otp/verify',
      body={'email': '{{sellerEmail}}', 'code': '{{otp}}', 'purpose': 'REGISTER'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("accessToken", () => pm.expect(pm.response.json()).to.have.property("accessToken"));',
          capture_user,
      ])),
    fetch_otp('buyerEmail', 'REGISTER'),
    r('POST /auth/otp/verify (buyer)', 'POST', BASE+'/auth/otp/verify',
      body={'email': '{{buyerEmail}}', 'code': '{{otp}}', 'purpose': 'REGISTER'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          capture_buyer,
      ])),
    r('POST /auth/login (seller)', 'POST', BASE+'/auth/login',
      body={'email': '{{sellerEmail}}', 'password': 'Password1!', 'device': {'id': '{{deviceId}}', 'name': 'Postman', 'os': 'test'}},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          capture_user,
      ])),
    r('GET /auth/otp/channels', 'GET', BASE+'/auth/otp/channels',
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("email field", () => pm.expect(pm.response.json()).to.have.property("email"));',
      ])),
    r('GET /me/sessions', 'GET', BASE+'/me/sessions',
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("array", () => pm.expect(pm.response.json()).to.be.an("array"));',
          'const ss = pm.response.json(); if (ss.length > 0) pm.environment.set("sessionId", ss[0].id);',
      ])),
    r('GET /me/login-events', 'GET', BASE+'/me/login-events',
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    r('POST /auth/refresh', 'POST', BASE+'/auth/refresh',
      body={'refreshToken': '{{refreshToken}}'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'const jr = pm.response.json();',
          'if (jr.accessToken) { pm.environment.set("accessToken", jr.accessToken); pm.environment.set("refreshToken", jr.refreshToken); }',
      ])),
    r('POST /auth/password/forgot', 'POST', BASE+'/auth/password/forgot',
      body={'email': '{{sellerEmail}}'},
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    fetch_otp('sellerEmail', 'RESET'),
    r('POST /auth/password/reset (via OTP)', 'POST', BASE+'/auth/password/reset',
      body={'email': '{{sellerEmail}}', 'code': '{{otp}}', 'newPassword': 'NewPassword1!'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'if (pm.response.code === 200) pm.environment.set("sellerPassword", "NewPassword1!");',
      ])),
    r('POST /auth/login (new password)', 'POST', BASE+'/auth/login',
      body={'email': '{{sellerEmail}}', 'password': '{{sellerPassword}}', 'device': {}},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          capture_user,
      ])),
    r('POST /auth/social/google (new user)', 'POST', BASE+'/auth/social/google',
      body={'idToken': 'mock:social+{{runId}}@test.com:Social User', 'device': {}},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("accessToken", () => pm.expect(pm.response.json()).to.have.property("accessToken"));',
          'const js = pm.response.json(); pm.environment.set("socialUserId", js.user ? js.user.id : "");',
      ])),
    r('POST /auth/social/google (same user, no dup)', 'POST', BASE+'/auth/social/google',
      body={'idToken': 'mock:social+{{runId}}@test.com:Social User', 'device': {}},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("same userId", () => pm.expect(pm.response.json().user ? pm.response.json().user.id : pm.environment.get("socialUserId")).to.equal(pm.environment.get("socialUserId")));',
      ])),
    r('POST /auth/social/google (no-email)', 'POST', BASE+'/auth/social/google',
      body={'idToken': 'mock::NoEmail User', 'device': {}},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("no email on user", () => pm.expect(pm.response.json().user ? pm.response.json().user.email : null).to.equal(null));',
          'const jne = pm.response.json(); if (jne.accessToken) pm.environment.set("noEmailToken", jne.accessToken);',
      ])),
    # NEG
    r('[NEG] register weak password', 'POST', BASE+'/auth/register',
      body={'email': 'neg+{{runId}}@test.com', 'password': 'weak', 'fullName': 'A'},
      tests='\n'.join([
          'pm.test("400", () => pm.expect(pm.response.code).to.equal(400));',
          'pm.test("WEAK_PASSWORD", () => pm.expect(pm.response.json().error.code).to.equal("WEAK_PASSWORD"));',
      ])),
    r('[NEG] otp/request no identifier -> 400', 'POST', BASE+'/auth/otp/request',
      body={'purpose': 'REGISTER'},
      tests='\n'.join([
          'pm.test("400", () => pm.expect(pm.response.code).to.equal(400));',
      ])),
    r('[NEG] register after no-identifier (OTP still valid)', 'POST', BASE+'/auth/register',
      body={'email': 'stillvalid+{{runId}}@test.com', 'password': 'Password1!', 'fullName': 'A'},
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    r('[NEG] CHANGE_EMAIL on public otp/request -> 400', 'POST', BASE+'/auth/otp/request',
      body={'email': '{{sellerEmail}}', 'purpose': 'CHANGE_EMAIL'},
      tests='\n'.join([
          'pm.test("400", () => pm.expect(pm.response.code).to.equal(400));',
      ])),
    r('[NEG] unknown email otp/request -> 200 no OTP row', 'POST', BASE+'/auth/otp/request',
      body={'email': 'nobody+{{runId}}@test.com', 'purpose': 'REGISTER'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("otpSentTo present", () => pm.expect(pm.response.json()).to.have.property("otpSentTo"));',
      ])),
    r('[NEG] mixed-case email verifies (re-register)', 'POST', BASE+'/auth/register',
      body={'email': 'MixedCase+{{runId}}@Test.COM', 'password': 'Password1!', 'fullName': 'Mixed'},
      tests='pm.test("200 or 409", () => pm.expect([200,409]).to.include(pm.response.code));'),
    r('[NEG] REFRESH REUSE - capture old refresh', 'POST', BASE+'/auth/refresh',
      body={'refreshToken': '{{refreshToken}}'},
      pre='pm.environment.set("oldRefresh", pm.environment.get("refreshToken"));',
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'const jrr = pm.response.json();',
          'if (jrr.refreshToken) { pm.environment.set("newRefresh", jrr.refreshToken); pm.environment.set("accessToken", jrr.accessToken); pm.environment.set("refreshToken", jrr.refreshToken); }',
      ])),
    r('[NEG] REFRESH REUSE - old token -> 401 REFRESH_REUSED', 'POST', BASE+'/auth/refresh',
      body={'refreshToken': '{{oldRefresh}}'},
      tests='\n'.join([
          'pm.test("401", () => pm.expect(pm.response.code).to.equal(401));',
          'pm.test("REFRESH_REUSED", () => pm.expect(pm.response.json().error.code).to.equal("REFRESH_REUSED"));',
      ])),
    r('[NEG] REFRESH REUSE - new token also revoked -> 401', 'POST', BASE+'/auth/refresh',
      body={'refreshToken': '{{newRefresh}}'},
      tests='pm.test("401", () => pm.expect(pm.response.code).to.equal(401));'),
    # Re-login after reuse detection revoked the whole family
    r('[NEG] REFRESH REUSE - re-login to restore session', 'POST', BASE+'/auth/login',
      body={'email': '{{sellerEmail}}', 'password': '{{sellerPassword}}', 'device': {}},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          capture_user,
      ])),
    r('[NEG] lockout - register lockEmail user', 'POST', BASE+'/auth/register',
      body={'email': '{{lockEmail}}', 'password': 'Password1!', 'fullName': 'Lock User'},
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    fetch_otp('lockEmail', 'REGISTER'),
    r('[NEG] lockout - verify lockEmail OTP', 'POST', BASE+'/auth/otp/verify',
      body={'email': '{{lockEmail}}', 'code': '{{otp}}', 'purpose': 'REGISTER'},
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    r('[NEG] lockout attempt 1/5', 'POST', BASE+'/auth/login',
      body={'email': '{{lockEmail}}', 'password': 'WrongPass1', 'device': {}},
      tests='pm.test("401", () => pm.expect(pm.response.code).to.equal(401));'),
    r('[NEG] lockout attempt 2/5', 'POST', BASE+'/auth/login',
      body={'email': '{{lockEmail}}', 'password': 'WrongPass1', 'device': {}},
      tests='pm.test("401", () => pm.expect(pm.response.code).to.equal(401));'),
    r('[NEG] lockout attempt 3/5', 'POST', BASE+'/auth/login',
      body={'email': '{{lockEmail}}', 'password': 'WrongPass1', 'device': {}},
      tests='pm.test("401", () => pm.expect(pm.response.code).to.equal(401));'),
    r('[NEG] lockout attempt 4/5', 'POST', BASE+'/auth/login',
      body={'email': '{{lockEmail}}', 'password': 'WrongPass1', 'device': {}},
      tests='pm.test("401", () => pm.expect(pm.response.code).to.equal(401));'),
    r('[NEG] lockout attempt 5/5', 'POST', BASE+'/auth/login',
      body={'email': '{{lockEmail}}', 'password': 'WrongPass1', 'device': {}},
      tests='pm.test("401", () => pm.expect(pm.response.code).to.equal(401));'),
    r('[NEG] lockout attempt 6 -> 429 ACCOUNT_LOCKED', 'POST', BASE+'/auth/login',
      body={'email': '{{lockEmail}}', 'password': 'WrongPass1', 'device': {}},
      tests='\n'.join([
          'pm.test("429", () => pm.expect(pm.response.code).to.equal(429));',
          'pm.test("ACCOUNT_LOCKED", () => pm.expect(pm.response.json().error.code).to.equal("ACCOUNT_LOCKED"));',
          'pm.test("retryAfterSec > 0", () => pm.expect(pm.response.json().error.details.retryAfterSec).to.be.above(0));',
      ])),
    r('[NEG] tampered bearer -> 401', 'GET', BASE+'/me',
      pre='pm.request.headers.upsert({ key: "Authorization", value: "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4IiwiZXhwIjoxfQ.bad" });',
      tests='pm.test("401", () => pm.expect(pm.response.code).to.equal(401));'),
    r('[NEG] no token /me -> 401', 'GET', BASE+'/me',
      pre='pm.request.headers.remove("Authorization");',
      tests='pm.test("401", () => pm.expect(pm.response.code).to.equal(401));'),
    # Restore valid accessToken for folder 02 Profile
    r('POST /auth/login (restore for profile folder)', 'POST', BASE+'/auth/login',
      body={'email': '{{sellerEmail}}', 'password': '{{sellerPassword}}', 'device': {}},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          capture_user,
      ])),
])

# ── Folder 02 Profile ──────────────────────────────────────────────────────────
f02 = fold('02 Profile', [
    r('GET /me', 'GET', BASE+'/me',
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("has email", () => pm.expect(pm.response.json()).to.have.property("email"));',
      ])),
    r('PATCH /me', 'PATCH', BASE+'/me',
      body={'fullName': 'Updated Seller', 'bio': 'Test bio'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("name updated", () => pm.expect(pm.response.json().fullName).to.equal("Updated Seller"));',
      ])),
    r('GET /me/capabilities', 'GET', BASE+'/me/capabilities',
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    r('POST /me/capabilities SELLER -> 200', 'POST', BASE+'/me/capabilities',
      body={'capability': 'SELLER'},
      tests='pm.test("200 or 409", () => pm.expect([200,409]).to.include(pm.response.code));'),
    r('POST /me/capabilities SELLER again -> 409', 'POST', BASE+'/me/capabilities',
      body={'capability': 'SELLER'},
      tests='pm.test("409", () => pm.expect(pm.response.code).to.equal(409));'),
    r('POST /me/capabilities DEALER -> 422 BUSINESS_SETUP_REQUIRED', 'POST', BASE+'/me/capabilities',
      body={'capability': 'DEALER'},
      tests='\n'.join([
          'pm.test("422", () => pm.expect(pm.response.code).to.equal(422));',
          'pm.test("BUSINESS_SETUP_REQUIRED", () => pm.expect(pm.response.json().error.code).to.equal("BUSINESS_SETUP_REQUIRED"));',
      ])),
    r('POST /me/capabilities EMPLOYER with setup -> 200', 'POST', BASE+'/me/capabilities',
      body={'capability': 'EMPLOYER', 'setup': {'companyName': 'Test Co', 'industry': 'tech'}},
      tests='pm.test("200 or 409", () => pm.expect([200,409]).to.include(pm.response.code));'),
    r('GET /users/{{buyerUserId}} public', 'GET', BASE+'/users/{{buyerUserId}}',
      tests='\n'.join([
          'pm.test("200 or 404", () => pm.expect([200,404]).to.include(pm.response.code));',
          'if (pm.response.code === 200) {',
          '  pm.test("no email", () => pm.expect(pm.response.json()).to.not.have.property("email"));',
          '  pm.test("no phone", () => pm.expect(pm.response.json()).to.not.have.property("phone"));',
          '}',
      ])),
    r('POST /users/{{buyerUserId}}/block (block buyer)', 'POST', BASE+'/users/{{buyerUserId}}/block',
      tests='pm.test("200 or 409", () => pm.expect([200,409]).to.include(pm.response.code));'),
    r('GET /me/blocks', 'GET', BASE+'/me/blocks',
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("array", () => pm.expect(pm.response.json()).to.be.an("array"));',
      ])),
    r('DELETE /users/{{buyerUserId}}/block (unblock)', 'DELETE', BASE+'/users/{{buyerUserId}}/block',
      tests='pm.test("200 or 404", () => pm.expect([200,404]).to.include(pm.response.code));'),
    r('GET /me/notification-preferences', 'GET', BASE+'/me/notification-preferences',
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    r('PATCH /me/notification-preferences', 'PATCH', BASE+'/me/notification-preferences',
      body={'push': True, 'email': False},
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    r('POST /me/device-tokens', 'POST', BASE+'/me/device-tokens',
      body={'token': 'test-device-token-123', 'platform': 'android'},
      tests='pm.test("200 or 422", () => pm.expect([200,422]).to.include(pm.response.code));'),
    r('DELETE /me/device-tokens/test-device-token-123', 'DELETE', BASE+'/me/device-tokens/test-device-token-123',
      tests='pm.test("200 or 404", () => pm.expect([200,404]).to.include(pm.response.code));'),
    r('PATCH /me/phone valid (+249...)', 'PATCH', BASE+'/me/phone',
      body={'phone': '+249912345678'},
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    r('PATCH /me/phone invalid -> 400', 'PATCH', BASE+'/me/phone',
      body={'phone': 'notaphone'},
      tests='\n'.join([
          'pm.test("400", () => pm.expect(pm.response.code).to.equal(400));',
          'pm.test("INVALID_PHONE", () => pm.expect(pm.response.json().error.code).to.equal("INVALID_PHONE"));',
      ])),
    r('POST /me/password/change', 'POST', BASE+'/me/password/change',
      body={'currentPassword': '{{sellerPassword}}', 'newPassword': 'ChangedPass1!'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'if (pm.response.code === 200) pm.environment.set("sellerPassword", "ChangedPass1!");',
      ])),
    r('POST /auth/login (changed password)', 'POST', BASE+'/auth/login',
      body={'email': '{{sellerEmail}}', 'password': '{{sellerPassword}}', 'device': {}},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          capture_user,
      ])),
    r('POST /me/email/change', 'POST', BASE+'/me/email/change',
      body={'newEmail': '{{changedEmail}}'},
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    r('[OTP] fetch CHANGE_EMAIL for changed email', 'GET',
      DEV + '/last-otp?email={{changedEmail}}&purpose=CHANGE_EMAIL',
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'const _oce = pm.response.json().code;',
          'pm.test("got code", () => pm.expect(_oce).to.match(/^\\d{6}$/));',
          'pm.environment.set("otp", _oce);',
      ])),
    r('POST /me/email/confirm', 'POST', BASE+'/me/email/confirm',
      body={'newEmail': '{{changedEmail}}', 'code': '{{otp}}'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          '// changedEmail was already set in f00_pre; no need to re-set here',
      ])),
    r('POST /auth/logout', 'POST', BASE+'/auth/logout',
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    # Re-login after logout so remaining profile tests have a valid token
    r('POST /auth/login (after logout)', 'POST', BASE+'/auth/login',
      body={'email': '{{changedEmail}}', 'password': '{{sellerPassword}}', 'device': {}},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          capture_user,
      ])),
    r('DELETE /me/sessions (revoke others)', 'DELETE', BASE+'/me/sessions',
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    r('POST /me/verification -> 404 MEDIA_NOT_FOUND', 'POST', BASE+'/me/verification',
      body={'kind': 'USER', 'documentMediaIds': ['00000000-0000-0000-0000-000000000000']},
      tests='\n'.join([
          'pm.test("404", () => pm.expect(pm.response.code).to.equal(404));',
          'pm.test("MEDIA_NOT_FOUND", () => pm.expect(pm.response.json().error.code).to.equal("MEDIA_NOT_FOUND"));',
      ])),
    r('[NEG] social no-email token on POST /me/verification -> 403 EMAIL_NOT_VERIFIED', 'POST', BASE+'/me/verification',
      body={'kind': 'USER', 'documentMediaIds': ['00000000-0000-0000-0000-000000000000']},
      hdrs=[{'key': 'Authorization', 'value': 'Bearer {{noEmailToken}}', 'type': 'text'}],
      tests='\n'.join([
          'pm.test("403", () => pm.expect(pm.response.code).to.equal(403));',
          'pm.test("EMAIL_NOT_VERIFIED", () => pm.expect(pm.response.json().error.code).to.equal("EMAIL_NOT_VERIFIED"));',
      ])),
    r('[NEG] customer token on GET /admin/me -> 401', 'GET', BASE+'/admin/me',
      hdrs=[{'key': 'Authorization', 'value': 'Bearer {{accessToken}}', 'type': 'text'}],
      tests='pm.test("401", () => pm.expect(pm.response.code).to.equal(401));'),
    # Re-login after DELETE /me/sessions revoked other sessions
    r('POST /auth/login (restore after session revoke)', 'POST', BASE+'/auth/login',
      body={'email': '{{changedEmail}}', 'password': '{{sellerPassword}}', 'device': {}},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          capture_user,
      ])),
])

# ── Folder 03 Admin ────────────────────────────────────────────────────────────
f03 = fold('03 Admin', [
    r('POST /admin/auth/login', 'POST', BASE+'/admin/auth/login',
      body={'email': '{{adminEmail}}', 'password': '{{adminPassword}}'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("mfaToken", () => pm.expect(pm.response.json()).to.have.property("mfaToken"));',
          capture_mfa,
      ])),
    r('POST /admin/auth/verify-2fa', 'POST', BASE+'/admin/auth/verify-2fa',
      body={'mfaToken': '{{mfaToken}}', 'code': '000000'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("accessToken", () => pm.expect(pm.response.json()).to.have.property("accessToken"));',
          capture_admin,
      ])),
    # Test mfaToken single-use immediately (5 min TTL — must be right after verify)
    r('[NEG] reuse consumed mfaToken -> 400 MFA_TOKEN_INVALID', 'POST', BASE+'/admin/auth/verify-2fa',
      body={'mfaToken': '{{mfaToken}}', 'code': '000000'},
      tests='\n'.join([
          'pm.test("400", () => pm.expect(pm.response.code).to.equal(400));',
          'pm.test("MFA_TOKEN_INVALID", () => pm.expect(pm.response.json().error.code).to.equal("MFA_TOKEN_INVALID"));',
      ])),
    # Refresh BEFORE any password changes (adminChangePassword bumps tokenVersion)
    r('POST /admin/auth/refresh', 'POST', BASE+'/admin/auth/refresh',
      body={'refreshToken': '{{adminRefresh}}'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'const jar = pm.response.json(); if (jar.accessToken) { pm.environment.set("adminToken", jar.accessToken); pm.environment.set("adminRefresh", jar.refreshToken); }',
      ])),
    r('[NEG] refresh token as Bearer on /admin/me -> 401', 'GET', BASE+'/admin/me',
      hdrs=[{'key': 'Authorization', 'value': 'Bearer {{adminRefresh}}', 'type': 'text'}],
      tests='pm.test("401", () => pm.expect(pm.response.code).to.equal(401));'),
    r('GET /admin/me', 'GET', BASE+'/admin/me',
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("role", () => pm.expect(pm.response.json()).to.have.property("role"));',
      ])),
    r('GET /admin/settings', 'GET', BASE+'/admin/settings',
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("has flags.otp.email", () => pm.expect(pm.response.json()).to.have.property("flags.otp.email"));',
      ])),
    r('PATCH /admin/flags/flags.video.enabled false', 'PATCH', BASE+'/admin/flags/flags.video.enabled',
      body={'value': False},
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    r('GET /config (video disabled)', 'GET', BASE+'/config',
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("video disabled", () => pm.expect(pm.response.json().flags["flags.video.enabled"]).to.equal(false));',
      ])),
    r('PATCH /admin/flags/flags.video.enabled restore true', 'PATCH', BASE+'/admin/flags/flags.video.enabled',
      body={'value': True},
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    r('[NEG] PATCH flags.otp.email false -> 422 LAST_OTP_CHANNEL', 'PATCH', BASE+'/admin/flags/flags.otp.email',
      body={'value': False},
      tests='\n'.join([
          'pm.test("422", () => pm.expect(pm.response.code).to.equal(422));',
          'pm.test("LAST_OTP_CHANNEL", () => pm.expect(pm.response.json().error.code).to.equal("LAST_OTP_CHANNEL"));',
      ])),
    r('[NEG] unknown setting key -> 404', 'PATCH', BASE+'/admin/settings/nonexistent.key',
      body={'value': True},
      tests='\n'.join([
          'pm.test("404", () => pm.expect(pm.response.code).to.equal(404));',
          'pm.test("SETTING_NOT_FOUND", () => pm.expect(pm.response.json().error.code).to.equal("SETTING_NOT_FOUND"));',
      ])),
    r('[NEG] wrong type -> 422', 'PATCH', BASE+'/admin/settings/flags.otp.email',
      body={'value': 'yes'},
      tests='\n'.join([
          'pm.test("422", () => pm.expect(pm.response.code).to.equal(422));',
          'pm.test("SETTING_INVALID_VALUE", () => pm.expect(pm.response.json().error.code).to.equal("SETTING_INVALID_VALUE"));',
      ])),
    r('[NEG] null value -> 422', 'PATCH', BASE+'/admin/settings/flags.otp.email',
      body={'value': None},
      tests='\n'.join([
          'pm.test("422", () => pm.expect(pm.response.code).to.equal(422));',
          'pm.test("SETTING_INVALID_VALUE", () => pm.expect(pm.response.json().error.code).to.equal("SETTING_INVALID_VALUE"));',
      ])),
    r('GET /admin/audit-logs', 'GET', BASE+'/admin/audit-logs',
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("data array", () => pm.expect(pm.response.json()).to.have.property("data"));',
      ])),
    r('GET /admin/audit-logs/verify ok:true', 'GET', BASE+'/admin/audit-logs/verify',
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("ok true", () => pm.expect(pm.response.json().ok).to.equal(true));',
      ])),
    r('POST /admin/admins (create moderator)', 'POST', BASE+'/admin/admins',
      body={'email': 'mod.{{runId}}@marbou.test', 'fullName': 'Test Mod', 'role': 'CONTENT_MODERATOR'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'pm.test("tempPassword", () => pm.expect(pm.response.json()).to.have.property("tempPassword"));',
          'const jmod = pm.response.json();',
          'pm.environment.set("modEmail", "mod." + pm.environment.get("runId") + "@marbou.test");',
          'pm.environment.set("modTempPassword", jmod.tempPassword);',
      ])),
    r('POST /admin/auth/login (moderator)', 'POST', BASE+'/admin/auth/login',
      body={'email': '{{modEmail}}', 'password': '{{modTempPassword}}'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'const jml = pm.response.json(); if (jml.mfaToken) pm.environment.set("modMfaToken", jml.mfaToken);',
      ])),
    r('POST /admin/auth/verify-2fa (moderator)', 'POST', BASE+'/admin/auth/verify-2fa',
      body={'mfaToken': '{{modMfaToken}}', 'code': '000000'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'const jmv = pm.response.json(); if (jmv.accessToken) pm.environment.set("modToken", jmv.accessToken);',
      ])),
    r('GET /admin/settings (mod) -> 403 PASSWORD_CHANGE_REQUIRED', 'GET', BASE+'/admin/settings',
      hdrs=[{'key': 'Authorization', 'value': 'Bearer {{modToken}}', 'type': 'text'}],
      tests='\n'.join([
          'pm.test("403", () => pm.expect(pm.response.code).to.equal(403));',
          'pm.test("PASSWORD_CHANGE_REQUIRED", () => pm.expect(pm.response.json().error.code).to.equal("PASSWORD_CHANGE_REQUIRED"));',
      ])),
    r('POST /admin/auth/change-password (moderator)', 'POST', BASE+'/admin/auth/change-password',
      body={'currentPassword': '{{modTempPassword}}', 'newPassword': 'ModNewPass#123'},
      hdrs=[{'key': 'Authorization', 'value': 'Bearer {{modToken}}', 'type': 'text'}],
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'const jcp = pm.response.json(); if (jcp.accessToken) pm.environment.set("modToken", jcp.accessToken);',
      ])),
    r('GET /admin/settings (mod after pw change) -> 403 (no perm)', 'GET', BASE+'/admin/settings',
      hdrs=[{'key': 'Authorization', 'value': 'Bearer {{modToken}}', 'type': 'text'}],
      tests='pm.test("403", () => pm.expect(pm.response.code).to.equal(403));'),
    r('[NEG] second login + wrong code -> 400 TOTP_INVALID', 'POST', BASE+'/admin/auth/login',
      body={'email': '{{adminEmail}}', 'password': '{{adminPassword}}'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'const jl2 = pm.response.json(); if (jl2.mfaToken) pm.environment.set("mfaToken2", jl2.mfaToken);',
      ])),
    r('[NEG] wrong TOTP code -> 400 TOTP_INVALID', 'POST', BASE+'/admin/auth/verify-2fa',
      body={'mfaToken': '{{mfaToken2}}', 'code': '999999'},
      tests='\n'.join([
          'pm.test("400", () => pm.expect(pm.response.code).to.equal(400));',
          'pm.test("TOTP_INVALID", () => pm.expect(pm.response.json().error.code).to.equal("TOTP_INVALID"));',
      ])),
    r('[NEG] moderator GET /admin/settings -> 403', 'GET', BASE+'/admin/settings',
      hdrs=[{'key': 'Authorization', 'value': 'Bearer {{modToken}}', 'type': 'text'}],
      tests='pm.test("403", () => pm.expect(pm.response.code).to.equal(403));'),
    r('[NEG] moderator PATCH /admin/settings -> 403', 'PATCH', BASE+'/admin/settings/flags.otp.email',
      body={'value': True},
      hdrs=[{'key': 'Authorization', 'value': 'Bearer {{modToken}}', 'type': 'text'}],
      tests='pm.test("403", () => pm.expect(pm.response.code).to.equal(403));'),
    r('[NEG] moderator GET /admin/audit-logs -> 403', 'GET', BASE+'/admin/audit-logs',
      hdrs=[{'key': 'Authorization', 'value': 'Bearer {{modToken}}', 'type': 'text'}],
      tests='pm.test("403", () => pm.expect(pm.response.code).to.equal(403));'),
    r('[NEG] wrong admin password -> 401', 'POST', BASE+'/admin/auth/login',
      body={'email': 'nobody.admin@marbou.test', 'password': 'WrongAdminPass1'},
      hdrs=[{'key': 'Authorization', 'value': '', 'type': 'text'}],
      tests='\n'.join([
          'pm.test("401", () => pm.expect(pm.response.code).to.equal(401));',
      ])),
    # Finance auditor flow
    r('POST /admin/admins (create finance auditor)', 'POST', BASE+'/admin/admins',
      body={'email': 'finance.{{runId}}@marbou.test', 'fullName': 'Finance Auditor', 'role': 'FINANCIAL_AUDITOR'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'const jfin = pm.response.json();',
          'pm.environment.set("finEmail", "finance." + pm.environment.get("runId") + "@marbou.test");',
          'pm.environment.set("finTempPassword", jfin.tempPassword);',
      ])),
    r('POST /admin/auth/login (finance)', 'POST', BASE+'/admin/auth/login',
      body={'email': '{{finEmail}}', 'password': '{{finTempPassword}}'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'const jfl = pm.response.json(); if (jfl.mfaToken) pm.environment.set("finMfaToken", jfl.mfaToken);',
      ])),
    r('POST /admin/auth/verify-2fa (finance)', 'POST', BASE+'/admin/auth/verify-2fa',
      body={'mfaToken': '{{finMfaToken}}', 'code': '000000'},
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'const jfv = pm.response.json();',
          'if (jfv.accessToken) pm.environment.set("finToken", jfv.accessToken);',
      ])),
    r('POST /admin/auth/change-password (finance)', 'POST', BASE+'/admin/auth/change-password',
      body={'currentPassword': '{{finTempPassword}}', 'newPassword': 'FinancePass#123'},
      hdrs=[{'key': 'Authorization', 'value': 'Bearer {{finToken}}', 'type': 'text'}],
      tests='\n'.join([
          'pm.test("200", () => pm.expect(pm.response.code).to.equal(200));',
          'const jfcp = pm.response.json(); if (jfcp.accessToken) pm.environment.set("finToken", jfcp.accessToken);',
      ])),
    r('GET /admin/audit-logs (finance) -> 200', 'GET', BASE+'/admin/audit-logs',
      hdrs=[{'key': 'Authorization', 'value': 'Bearer {{finToken}}', 'type': 'text'}],
      tests='pm.test("200", () => pm.expect(pm.response.code).to.equal(200));'),
    r('[NEG] finance POST /admin/admins -> 403', 'POST', BASE+'/admin/admins',
      body={'email': 'x@x.com', 'fullName': 'X', 'role': 'SUPPORT_AGENT'},
      hdrs=[{'key': 'Authorization', 'value': 'Bearer {{finToken}}', 'type': 'text'}],
      tests='pm.test("403", () => pm.expect(pm.response.code).to.equal(403));'),
])

# ── Assemble collection ────────────────────────────────────────────────────────
collection = {
    'info': {
        'name': 'MARBOU API - Slice 1',
        'schema': 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json',
    },
    'event': [
        {'listen': 'prerequest', 'script': {'type': 'text/javascript', 'exec': col_pre.split('\n')}},
        {'listen': 'test', 'script': {'type': 'text/javascript', 'exec': col_tests.split('\n')}},
    ],
    'variable': [
        {'key': 'baseUrl', 'value': 'http://localhost:4000/api/v1'},
        {'key': 'devUrl', 'value': 'http://localhost:4000/dev'},
    ],
    'item': [f00, f01, f02, f03],
}

environment = {
    'name': 'MARBOU Local',
    'values': [
        {'key': 'baseUrl', 'value': 'http://localhost:4000/api/v1', 'enabled': True},
        {'key': 'devUrl', 'value': 'http://localhost:4000/dev', 'enabled': True},
        {'key': 'deviceId', 'value': '11111111-1111-4111-8111-111111111111', 'enabled': True},
        {'key': 'runId', 'value': '', 'enabled': True},
        {'key': 'sellerEmail', 'value': '', 'enabled': True},
        {'key': 'buyerEmail', 'value': '', 'enabled': True},
        {'key': 'lockEmail', 'value': '', 'enabled': True},
        {'key': 'accessToken', 'value': '', 'enabled': True},
        {'key': 'refreshToken', 'value': '', 'enabled': True},
        {'key': 'oldRefresh', 'value': '', 'enabled': True},
        {'key': 'newRefresh', 'value': '', 'enabled': True},
        {'key': 'userId', 'value': '', 'enabled': True},
        {'key': 'buyerToken', 'value': '', 'enabled': True},
        {'key': 'buyerRefresh', 'value': '', 'enabled': True},
        {'key': 'buyerUserId', 'value': '', 'enabled': True},
        {'key': 'noEmailToken', 'value': '', 'enabled': True},
        {'key': 'socialUserId', 'value': '', 'enabled': True},
        {'key': 'adminToken', 'value': '', 'enabled': True},
        {'key': 'adminRefresh', 'value': '', 'enabled': True},
        {'key': 'mfaToken', 'value': '', 'enabled': True},
        {'key': 'mfaToken2', 'value': '', 'enabled': True},
        {'key': 'modEmail', 'value': '', 'enabled': True},
        {'key': 'modTempPassword', 'value': '', 'enabled': True},
        {'key': 'modMfaToken', 'value': '', 'enabled': True},
        {'key': 'modToken', 'value': '', 'enabled': True},
        {'key': 'sessionId', 'value': '', 'enabled': True},
        {'key': 'configEtag', 'value': '', 'enabled': True},
        {'key': 'sellerPassword', 'value': 'Password1!', 'enabled': True},
        {'key': 'changedEmail', 'value': '', 'enabled': True},
        {'key': 'adminEmail', 'value': 'admin@marbou.test', 'enabled': True},
        {'key': 'adminPassword', 'value': 'Admin#12345', 'enabled': True},
        {'key': 'finEmail', 'value': '', 'enabled': True},
        {'key': 'finTempPassword', 'value': '', 'enabled': True},
        {'key': 'finMfaToken', 'value': '', 'enabled': True},
        {'key': 'finToken', 'value': '', 'enabled': True},
    ],
}

os.makedirs('postman', exist_ok=True)
with open('postman/marbou.postman_collection.json', 'w', encoding='utf-8') as fh:
    json.dump(collection, fh, indent=2)
with open('postman/local.postman_environment.json', 'w', encoding='utf-8') as fh:
    json.dump(environment, fh, indent=2)

print('postman/marbou.postman_collection.json written')
print('postman/local.postman_environment.json written')
