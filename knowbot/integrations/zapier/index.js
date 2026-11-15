// KnowBot for Zapier (Zapier Platform CLI app). One trigger: New Lead (a REST hook, with a polling list for samples).
// The KnowBot side is server/crm/routes.mjs: /api/studio/zapier/v1/{me,leads,hooks}. Not published: see README.md.
'use strict';

const authentication = require('./authentication');
const newLead = require('./triggers/new_lead');
const { version } = require('./package.json');
const platformVersion = require('zapier-platform-core').version;

/** Every request carries the bot's API key; a 401 tells Zapier to ask the user to reconnect. */
const addApiKey = (request, z, bundle) => {
  if (bundle.authData && bundle.authData.apiKey) request.headers.Authorization = `Bearer ${bundle.authData.apiKey}`;
  request.headers['User-Agent'] = `knowbot-zapier/${version}`;
  return request;
};
const handleErrors = (response, z) => {
  if (response.status === 401) throw new z.errors.RefreshAuthError('Your KnowBot API key is no longer valid. Create a new one in KnowBot Studio (Stats & Leads, Connect your CRM, Zapier).');
  if (response.status >= 400) {
    let message = `KnowBot answered ${response.status}.`;
    try { message = (response.json && response.json.error && response.json.error.message) || message; } catch (e) { /* keep the default */ }
    throw new z.errors.Error(message, 'KnowBotError', response.status);
  }
  return response;
};

module.exports = {
  version,
  platformVersion,
  authentication,
  beforeRequest: [addApiKey],
  afterResponse: [handleErrors],
  triggers: { [newLead.key]: newLead },
  searches: {},
  creates: {},
};
