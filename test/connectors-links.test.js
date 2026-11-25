import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectors } from '../src/connectors.js';

const expected = {
  xkiro: { site: 'https://xkiro.com/', docs: 'https://docs.xkiro.com/guides/overview/' },
  maxrouter: { site: 'https://www.maxrouter.ai/', docs: 'https://www.maxrouter.ai/docs' },
  geraikita: { site: 'https://ai.geraikita.com/pt', docs: 'https://ai.geraikita.com/pt/docs' },
  '1minai': { site: 'https://1min.ai/', docs: 'https://docs.1min.ai/docs/api/intro' },
  wusrouter: { site: 'https://wusrouter.com/', docs: 'https://wusrouter.com/documents' },
  notholy: { site: 'https://notholy.com/', docs: 'https://docs.notholy.com/en' },
  hcnsec: { site: 'https://api.hcnsec.cn/', docs: 'https://hcnote.cn/' },
  a2e: { site: 'https://a2e.ai/pricing/', docs: 'https://video.a2e.ai/dev' },
  cosmospro: { site: 'https://cosmospro.dev/', docs: null },
  arena: { site: 'https://arena.ai/', docs: 'https://platform.arena.ai/docs/api' },
  duck: { site: 'https://duck.ai/', docs: 'https://duckduckgo.com/duckduckgo-help-pages/duckai' },
};

test('perfis expõem site e documentação oficiais por HTTPS', () => {
  for (const [id, links] of Object.entries(expected)) {
    const profile = connectors.find(item => item.id === id);
    assert.ok(profile, `perfil ${id}`);
    assert.equal(profile.site, links.site, `site ${id}`);
    assert.equal(profile.docs || null, links.docs, `docs ${id}`);
    assert.match(profile.site, /^https:\/\//, `site HTTPS ${id}`);
    if (profile.docs) assert.match(profile.docs, /^https:\/\//, `docs HTTPS ${id}`);
  }
  const generic = connectors.find(item => item.id === 'generic');
  assert.equal(generic.site || null, null);
  assert.equal(generic.docs || null, null);
});
