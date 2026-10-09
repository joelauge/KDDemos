/* KnowDrive corpus-unfurl demo data.
 *
 * LINKS stands in for the server-side link registry the dashboard writes to:
 * an opaque link id resolves to one store, a tag scope, and an entitlement set.
 * In production the id is the only thing in the URL — the scoped token lives
 * with the link on the server (see worker/unfurl-worker.js).
 *
 * ATOMS is a snapshot of real hybrid-search hits from the public "Canada"
 * store (vs_6164dda13277488abf2b8c7414f43c23 — parliamentary proceedings and
 * the federal Registry of Lobbyists), so the static demo searches real atoms.
 * Excerpts are trimmed (…) and per-atom tags are simplified for scoping demos.
 */
window.KD_UNFURL = {
  STORES: {
    'vs_6164dda13277488abf2b8c7414f43c23': {
      name: 'Canada · Public Record',
      short: 'Public Record',
      owner: 'KnowDrive Public',
      files: 12090,
      atoms: 391922,
      modalities: ['text', 'image', 'audio'],
      tags: ['collection:publicrecord', 'domain:lobbying', 'jurisdiction:ca', 'proceedings:committees', 'proceedings:hansard'],
      licence: 'Contains information licensed under the Open Government Licence – Canada and the Open Data Licence Agreement — Office of the Commissioner of Lobbying.'
    }
  },

  LINKS: {
    'pr-ca-7qx2': {
      label: 'Public Record — everything',
      store: 'vs_6164dda13277488abf2b8c7414f43c23',
      scope: [],
      ent: { atoms: true, files: true, snippet: true, open: true, share: true, image: true, audio: true },
      maxResults: 12,
      expires: null,
      channels: ['imessage', 'whatsapp', 'signal'],
      createdBy: 'KnowDrive Public'
    },
    'ethi-ai-k3m9': {
      label: 'ETHI committee — AI study',
      store: 'vs_6164dda13277488abf2b8c7414f43c23',
      scope: ['proceedings:committees'],
      ent: { atoms: true, files: false, snippet: true, open: false, share: true, image: false, audio: false },
      maxResults: 6,
      expires: '2026-12-31',
      channels: ['signal'],
      createdBy: 'KnowDrive Public'
    }
  },

  ATOMS: [
    {
      id: 'file-0WxFSzcN9EAc7QjKMigfLUe8:32816',
      file_id: 'file-0WxFSzcN9EAc7QjKMigfLUe8',
      filename: 'PublicRecord/proceedings/committees/ETHI/45-1/2025-11-26_meeting-19.md',
      title: 'ETHI — Meeting No. 19',
      breadcrumb: 'Standing Committee on Access to Information, Privacy and Ethics — Meeting No. 19',
      speaker: 'Antoine Guilmain', time: '17:05', date: '2025-11-26',
      tags: ['proceedings:committees', 'committee:ETHI', 'mime:text/markdown'],
      kind: 'text',
      text: "Indeed, we have many laws. I myself specialize in cybersecurity and protecting personal information. However, many other sectors directly impact artificial intelligence. I'm thinking of copyright, trademark rights and consumer protection… it seems to me there's a trend towards passing these laws because it feels good. It's like eating Nutella… What I see the most often down the line is that we have regulators who must apply these laws and have the skills to do so. We have regulators in Canada and Quebec who do extraordinary work. However, they lack the means to truly keep abreast of these changes."
    },
    {
      id: 'file-0WxFSzcN9EAc7QjKMigfLUe8:16829',
      file_id: 'file-0WxFSzcN9EAc7QjKMigfLUe8',
      filename: 'PublicRecord/proceedings/committees/ETHI/45-1/2025-11-26_meeting-19.md',
      title: 'ETHI — Meeting No. 19',
      breadcrumb: 'Standing Committee on Access to Information, Privacy and Ethics — Meeting No. 19',
      speaker: 'Abdelhaq Sari (Bourassa, Lib.)', time: '16:45', date: '2025-11-26',
      tags: ['proceedings:committees', 'committee:ETHI', 'mime:text/markdown'],
      kind: 'text',
      text: "Would asking the government to regulate technological development really be a viable solution, or would it be better to regulate the use of technologies to manage the risks? If I own a private company that creates technology, will we regulate how I do it, or rather regulate how that technology will be used afterwards? When I talk about use, I'm talking about the collection, processing, and communication of data, and the cycle is much more important."
    },
    {
      id: 'file-u15kbJGF14lkf8rjj04En8C1:12945',
      file_id: 'file-u15kbJGF14lkf8rjj04En8C1',
      filename: 'PublicRecord/proceedings/committees/ETHI/45-1/2025-12-01_meeting-20.md',
      title: 'ETHI — Meeting No. 20',
      breadcrumb: 'Standing Committee on Access to Information, Privacy and Ethics — Meeting No. 20',
      speaker: 'Connor Leahy', time: '11:15', date: '2025-12-01',
      tags: ['proceedings:committees', 'committee:ETHI', 'mime:text/markdown'],
      kind: 'text',
      text: "A lot of the early research on what is now called deep learning and AI was done for social media recommendation algorithms… They are now pouring hundreds of millions of dollars into lobbying and other forums to try to prevent people from interfering. I think the same pattern of behaviour—developing a technology so quickly that governments cannot react and actively trying to slow down governments to prevent them from regulating this technology until it's already too late—is exactly the playbook we are seeing being deployed right now by AI companies."
    },
    {
      id: 'file-u15kbJGF14lkf8rjj04En8C1:24985',
      file_id: 'file-u15kbJGF14lkf8rjj04En8C1',
      filename: 'PublicRecord/proceedings/committees/ETHI/45-1/2025-12-01_meeting-20.md',
      title: 'ETHI — Meeting No. 20',
      breadcrumb: 'Standing Committee on Access to Information, Privacy and Ethics — Meeting No. 20',
      speaker: 'Luc Thériault', time: '11:25', date: '2025-12-01',
      tags: ['proceedings:committees', 'committee:ETHI', 'mime:text/markdown'],
      kind: 'text',
      text: "In Canada, Bill C‑27, which died on the Order Paper, proposed the creation of the Commissioner of Artificial Intelligence and Data position within Innovation, Science and Economic Development Canada. The recent Carney government has a Minister of Artificial Intelligence and Digital Innovation… Last June, he stated that he would place greater emphasis on finding ways to exploit the economic benefits of this technology rather than on regulation. What do you think of this approach?"
    },
    {
      id: 'file-EkhAVdCyuwOgqHnwlg5VpI9b:29140',
      file_id: 'file-EkhAVdCyuwOgqHnwlg5VpI9b',
      filename: 'PublicRecord/proceedings/committees/ETHI/45-1/2025-12-03_meeting-21.md',
      title: 'ETHI — Meeting No. 21',
      breadcrumb: 'Standing Committee on Access to Information, Privacy and Ethics — Meeting No. 21',
      speaker: 'Matthew da Mota', time: '17:00', date: '2025-12-03',
      tags: ['proceedings:committees', 'committee:ETHI', 'mime:text/markdown'],
      kind: 'text',
      text: "The first thing I would say is about the idea that regulation kills innovation. I think there's a lot of evidence that shows the contrary… In the EU AI Act context, some of the things that are prohibited are things like active subliminal or manipulative kinds of AI, biometric categorization by race… We still have probably the best or one of the best research environments for AI. A great pro of thinking about the right kind of regulation is that we could lead on developing the safe, useful AI that people actually want to use."
    },
    {
      id: 'file-EkhAVdCyuwOgqHnwlg5VpI9b:39383',
      file_id: 'file-EkhAVdCyuwOgqHnwlg5VpI9b',
      filename: 'PublicRecord/proceedings/committees/ETHI/45-1/2025-12-03_meeting-21.md',
      title: 'ETHI — Meeting No. 21',
      breadcrumb: 'Standing Committee on Access to Information, Privacy and Ethics — Meeting No. 21',
      speaker: 'Frédéric Gonzalo', time: '17:15', date: '2025-12-03',
      tags: ['proceedings:committees', 'committee:ETHI', 'mime:text/markdown'],
      kind: 'text',
      text: "The disinformation that is proliferating on social media such as X, Instagram and YouTube comes from bot farms or similar places… YouTube requires users to say whether or not their video content was generated using artificial intelligence. People are expected to be transparent when they publish their content… However, this mechanism almost always relies on people's goodwill. Perhaps these platforms should be forced to apply their user policies or terms and conditions."
    },
    {
      id: 'file-EkhAVdCyuwOgqHnwlg5VpI9b:1506',
      file_id: 'file-EkhAVdCyuwOgqHnwlg5VpI9b',
      filename: 'PublicRecord/proceedings/committees/ETHI/45-1/2025-12-03_meeting-21.md',
      title: 'ETHI — Meeting No. 21',
      breadcrumb: 'Standing Committee on Access to Information, Privacy and Ethics — Meeting No. 21',
      speaker: 'Frédéric Gonzalo', time: null, date: '2025-12-03',
      tags: ['proceedings:committees', 'committee:ETHI', 'mime:text/markdown'],
      kind: 'text',
      text: "The transformation of search engines into artificial intelligence engines has created a new challenge of digital discoverability. Businesses are now wondering how to be visible in ChatGPT, Perplexity or Gemini… SMEs now mostly use artificial intelligence to write texts, respond to customers, automate administrative tasks or create visuals. These are low-risk uses. Regulations should therefore be tiered: heavy and strict for systems that have a societal impact, but simple, pragmatic and accessible for everyday use in small organizations."
    },
    {
      id: 'file-pYa5bvFpE5fnyUiZ6ymac6GT:51377',
      file_id: 'file-pYa5bvFpE5fnyUiZ6ymac6GT',
      filename: 'PublicRecord/proceedings/committees/ETHI/45-1/2025-09-17_meeting-03.md',
      title: 'ETHI — Meeting No. 3',
      breadcrumb: 'Standing Committee on Access to Information, Privacy and Ethics — Meeting No. 3',
      speaker: 'Luc Thériault', time: '18:05', date: '2025-09-17',
      tags: ['proceedings:committees', 'committee:ETHI', 'mime:text/markdown'],
      kind: 'text',
      text: "My motion concerns a study on artificial intelligence… What are the positive and negative aspects of AI? How can we regulate the various applications of AI? When will governments reach a point of no return in terms of regulating artificial intelligence? How does artificial intelligence affect energy and environmental issues? Above all, how does artificial intelligence affect privacy and the control of access to information?"
    },
    {
      id: 'file-E7ykwBrVVLf3MoGNxjAHqwtI:455923',
      file_id: 'file-E7ykwBrVVLf3MoGNxjAHqwtI',
      filename: 'PublicRecord/proceedings/hansard/45-1/2025-11-20_sitting-057.md',
      title: 'Hansard — Sitting No. 57',
      breadcrumb: 'House of Commons Debates (Hansard) — Sitting No. 57 › Living Donor Recognition Medal Act',
      speaker: null, time: null, date: '2025-11-20',
      tags: ['proceedings:hansard', 'mime:text/markdown'],
      kind: 'text',
      text: "These regulations will cut up to 26 million tonnes of greenhouse gas pollution by 2030. They are supporting renewable diesel and hydrogen facilities in Alberta and Newfoundland and Labrador, and renewable gas and green hydrogen projects in Ontario and Quebec… Climate action is economic action. Industrial carbon pricing reduces energy waste, drives innovation, attracts private investment and strengthens Canada's long-term competitiveness."
    },
    {
      id: 'file-0V3yUJBGJmGtM717DBE8nPgE:40215',
      file_id: 'file-0V3yUJBGJmGtM717DBE8nPgE',
      filename: 'PublicRecord/proceedings/hansard/45-1/2025-09-22_sitting-026.md',
      title: 'Hansard — Sitting No. 26',
      breadcrumb: 'House of Commons Debates (Hansard) — Sitting No. 26 › Business of Supply',
      speaker: null, time: null, date: '2025-09-22',
      tags: ['proceedings:hansard', 'mime:text/markdown'],
      kind: 'text',
      text: "The Pathways Alliance, a coalition of the six largest oil sands companies, is proposing a $16.5‐billion carbon capture and storage network in Alberta. This project would capture CO2 from more than 20 facilities and transport it 400 kilometres away to a storage facility in the Cold Lake area, allowing between 10 million and 12 million tonnes of emissions to be stored every year… The world is hungry for clean energy, and Canada is uniquely positioned to supply it."
    },
    {
      id: 'file-0V3yUJBGJmGtM717DBE8nPgE:40215b',
      file_id: 'file-0V3yUJBGJmGtM717DBE8nPgE',
      filename: 'PublicRecord/proceedings/hansard/45-1/2025-09-22_sitting-026.md',
      title: 'Hansard — Sitting No. 26',
      breadcrumb: 'House of Commons Debates (Hansard) — Sitting No. 26 › Business of Supply',
      speaker: null, time: null, date: '2025-09-22',
      tags: ['proceedings:hansard', 'mime:text/markdown'],
      kind: 'text',
      text: "Occam's Technologies, a start-up based in Nisku, is tackling one area of the sector that is the most difficult to decarbonize: diesel engines in oil operations. With $2 million in federal support, its Direct Oxyfire Carbon Capture system is designed to capture more than 90% of CO2 emissions from diesel engines… Under the decarbonization incentive program, the federal government invested $150 million in 38 clean tech projects in Canadian industrial sectors."
    },
    {
      id: 'file-0V3yUJBGJmGtM717DBE8nPgE:341944',
      file_id: 'file-0V3yUJBGJmGtM717DBE8nPgE',
      filename: 'PublicRecord/proceedings/hansard/45-1/2025-09-22_sitting-026.md',
      title: 'Hansard — Sitting No. 26',
      breadcrumb: 'House of Commons Debates (Hansard) — Sitting No. 26 › Business of Supply',
      speaker: null, time: null, date: '2025-09-22',
      tags: ['proceedings:hansard', 'mime:text/markdown'],
      kind: 'text',
      text: "In 2023, 45% of Canada's total methane emissions originated from the oil and gas sector. Methane mitigation is one of the fastest, most cost-effective ways to reduce emissions. Canadian companies are already global leaders in this space, from designing sensors and satellites to detect emissions to developing the software and analytical methods to process the data… The government will ensure that the full value of the CCUS investment tax credit is extended to 2035."
    },
    {
      id: 'file-i64GCbj3HGkAECZM8482VnG5:434500',
      file_id: 'file-i64GCbj3HGkAECZM8482VnG5',
      filename: 'PublicRecord/proceedings/hansard/45-1/2025-06-09_sitting-011.md',
      title: 'Hansard — Sitting No. 11',
      breadcrumb: 'House of Commons Debates (Hansard) — Sitting No. 11 › Business of Supply',
      speaker: null, time: null, date: '2025-06-09',
      tags: ['proceedings:hansard', 'mime:text/markdown'],
      kind: 'text',
      text: "Waterloo's tech ecosystem is a hub for clean energy and environmental innovation. Our government has partnered with local institutions and businesses through initiatives such as Sustainable Development Technology Canada and the innovation superclusters initiative to fund cutting-edge projects in renewable energy, energy storage and smart grid technologies… Recent funding for flood mitigation projects and stormwater management systems exemplifies a proactive approach to climate adaptation."
    },
    {
      id: 'file-i64GCbj3HGkAECZM8482VnG5:409253',
      file_id: 'file-i64GCbj3HGkAECZM8482VnG5',
      filename: 'PublicRecord/proceedings/hansard/45-1/2025-06-09_sitting-011.md',
      title: 'Hansard — Sitting No. 11',
      breadcrumb: 'House of Commons Debates (Hansard) — Sitting No. 11 › Business of Supply',
      speaker: null, time: null, date: '2025-06-09',
      tags: ['proceedings:hansard', 'mime:text/markdown'],
      kind: 'text',
      text: "The funding will allow Environment and Climate Change Canada to continue providing national leadership… As the official source for weather information and weather warnings in Canada, we will continue to provide timely and accurate weather information, including severe weather alerts… The output-based pricing system, otherwise known as industrial carbon pricing, is funding innovative, job-creating Canadian technology projects. A terrific example of this is the $25 million that Redpath Sugar Ltd. received to install new equipment and technology."
    },
    {
      id: 'file-cx0zEPbqR6YVshV3oe2LuFtD:927',
      file_id: 'file-cx0zEPbqR6YVshV3oe2LuFtD',
      filename: 'PublicRecord/lobbying/clients/atkinsrealis.md',
      title: 'AtkinsRéalis — lobbying communications',
      breadcrumb: 'AtkinsRealis — federal lobbying communications',
      speaker: null, time: null, date: '2025-11',
      tags: ['domain:lobbying', 'licence:ocl-oda-2.0', 'mime:text/markdown'],
      kind: 'record',
      text: "Registrants who filed these communications: Letarte, Philippe (4). Activity by month — 2025-11: 4 communications. Communications are reported by the registrant under the Lobbying Act. A communication is a reported contact, not evidence of influence or of any outcome."
    },
    {
      id: 'file-zzt7rjD68bIcatZALS99Eurf:405',
      file_id: 'file-zzt7rjD68bIcatZALS99Eurf',
      filename: 'PublicRecord/lobbying/clients/momentum.md',
      title: 'Momentum — lobbying communications',
      breadcrumb: 'Momentum — federal lobbying communications',
      speaker: null, time: null, date: '2025-02',
      tags: ['domain:lobbying', 'licence:ocl-oda-2.0', 'mime:text/markdown'],
      kind: 'record',
      text: "Registrants who filed these communications: Loomis, Jeff (1). Activity by month — 2025-02: 1 communication. Communications are reported by the registrant under the Lobbying Act. A communication is a reported contact, not evidence of influence or of any outcome."
    },
    {
      id: 'file-5aApgxArqL93MMGN0xtSiVd9:467',
      file_id: 'file-5aApgxArqL93MMGN0xtSiVd9',
      filename: 'PublicRecord/lobbying/clients/gropyus.md',
      title: 'Gropyus — lobbying communications',
      breadcrumb: 'Gropyus — federal lobbying communications',
      speaker: null, time: null, date: '2025-10',
      tags: ['domain:lobbying', 'licence:ocl-oda-2.0', 'mime:text/markdown'],
      kind: 'record',
      text: "Registrants who filed these communications: Crouton, Romain (2). Activity by month — 2025-10: 2 communications. Communications are reported by the registrant under the Lobbying Act. A communication is a reported contact, not evidence of influence or of any outcome."
    },
    {
      id: 'file-fzF2BVbgMlSZWuIQDLIWTaN2:619',
      file_id: 'file-fzF2BVbgMlSZWuIQDLIWTaN2',
      filename: 'PublicRecord/lobbying/clients/ashini-consultants.md',
      title: 'Ashini Consultants — lobbying communications',
      breadcrumb: 'Ashini Consultants — federal lobbying communications',
      speaker: null, time: null, date: '2025-09',
      tags: ['domain:lobbying', 'licence:ocl-oda-2.0', 'mime:text/markdown'],
      kind: 'record',
      text: "Registrants who filed these communications: Simard, Yannick (1). Activity by month — 2025-09: 1 communication. Communications are reported by the registrant under the Lobbying Act. A communication is a reported contact, not evidence of influence or of any outcome."
    }
  ],

  SUGGESTIONS: ['AI regulation', 'carbon capture Alberta', 'methane emissions', 'lobbying communications', 'Bill C-27', 'clean tech funding']
};
