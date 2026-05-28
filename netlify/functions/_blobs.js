/**
 * Thin wrapper around @netlify/blobs that passes explicit credentials
 * (NETLIFY_SITE_ID + NETLIFY_TOKEN) when the automatic context isn't
 * injected — which happens on some Netlify site configurations.
 *
 * Required env vars (set in Netlify dashboard → Environment variables):
 *   NETLIFY_SITE_ID  — Site settings → General → Site details → Site ID
 *   NETLIFY_TOKEN    — User settings → Applications → Personal access tokens
 */
const { getStore } = require('@netlify/blobs');

function store(name) {
  const siteID = process.env.NETLIFY_SITE_ID;
  const token  = process.env.NETLIFY_TOKEN;
  if (siteID && token) {
    return getStore({ name, siteID, token });
  }
  // Fall back to automatic context (works when Netlify injects NETLIFY_BLOBS_CONTEXT)
  return getStore(name);
}

module.exports = { store };
