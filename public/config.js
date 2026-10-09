// BigBooks envelope budgeting configuration.
//
// Fill in CLIENT_ID with a PUBLIC OAuth client registered in BigBooks
// (token endpoint auth method "none", PKCE / S256). Create one at
// https://staging.bigbooks.app/clients. That client must have:
//   • Redirect URI  = this app's URL, e.g. http://localhost:5173/
//
// The CORS allow-list for /oauth2/token and /oauth2/userInfo is derived from the
// web origins of your registered redirect URIs, so registering the redirect URI
// is all it takes — there is no separate origin field. Note that
// http://localhost:5173 and http://127.0.0.1:5173 are DIFFERENT origins.
//
// No client secret goes here — this file ships to the browser. PKCE replaces it.

export const CONFIG = {
  CLIENT_ID: '',                                  // <-- your public client_id

  // Authorization server (issuer) and REST API live on different hosts.
  ISSUER: 'https://staging.bigbooks.app',
  API: 'https://staging.bigbooks.app/api',
  AUTHORIZE_URL: 'https://staging.bigbooks.app/oauth2/authorize',
  TOKEN_URL: 'https://staging.bigbooks.app/oauth2/token',
  USERINFO_URL: 'https://staging.bigbooks.app/oauth2/userInfo',

  // openid is required to receive the `bigbooks:party` userInfo claim.
  SCOPES: 'openid profile email',

  // Where the OAuth redirect lands. Must exactly match a registered redirect URI.
  REDIRECT_URI: window.location.origin + window.location.pathname,
};
