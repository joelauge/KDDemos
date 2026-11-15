// Authentication: a per-bot API key (kb_zap_…) the owner creates in KnowBot Studio: Stats & Leads, Connect your CRM,
// Zapier, "Create an API key". The test call is GET /zapier/v1/me → { id, name }.
'use strict';

const BASE = process.env.KNOWBOT_API_BASE || 'https://agent.knowbot.app/api/studio/zapier/v1';

module.exports = {
  type: 'custom',
  fields: [
    {
      key: 'apiKey',
      label: 'KnowBot API key',
      type: 'password',
      required: true,
      helpText: 'In KnowBot Studio open **Stats & Leads**, go to **Connect your CRM**, choose **Zapier** and **Create an API key**. It starts with `kb_zap_`.',
    },
  ],
  test: { url: `${BASE}/me`, method: 'GET' },
  connectionLabel: '{{name}}',
  BASE,
};
