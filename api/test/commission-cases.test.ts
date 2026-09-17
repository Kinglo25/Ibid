import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildCommissionCaseIndex, caseNamesAgree, createCommissionCaseIndexLoader, identifyCommissionCase } from '../src/commission-cases.ts';

/**
 * Fixtures in the shape the Commission actually publishes, which is the point of them.
 *
 * The datasets nest an attachment's fields under `decisions[].decisionAttachments[].metadata`
 * and encode coded values as JSON inside a string inside an array —
 * `["{\"code\":\"DocumentCategory0352\",\"label\":\"...\"}"]`. A fixture written in the shape
 * the code would prefer would pass while the real file did not, which is the failure these
 * exist to catch.
 */
const coded = (code: string, label: string) => [JSON.stringify({ code, label })];

type AttachmentFields = {
  link: string;
  category?: [string, string];
  name?: string;
  language?: string;
  date?: string;
  metadataType?: string;
};

function attachment(fields: AttachmentFields) {
  const metadata: Record<string, unknown> = {
    attachmentLink: [fields.link],
    metadataType: [fields.metadataType ?? 'METADATA_DECISION_ATTACHMENT'],
  };
  if (fields.category) metadata.attachmentCategory = coded(fields.category[0], fields.category[1]);
  if (fields.name) metadata.attachmentName = [fields.name];
  if (fields.language) metadata.attachmentLanguage = [fields.language];
  if (fields.date) metadata.attachmentDocumentDate = [fields.date];
  return { metadata };
}

const dataset = (cases: Record<string, AttachmentFields[]>) => JSON.stringify(
  Object.fromEntries(Object.entries(cases).map(([number, attachments]) => [
    number,
    { metadata: {}, caseAttachments: [], decisions: [{ metadata: {}, decisionAttachments: attachments.map(attachment) }] },
  ])),
);

const PROHIBITION: [string, string] = ['DocumentCategory0352', 'Prohibition Decision (Art. 7) (Art. 101 & 102 ex 81 & 82)'];

describe('the decision a Commission case number names', () => {
  test('finds the published decision for an antitrust case', () => {
    const index = buildCommissionCaseIndex([dataset({
      'AT.37990': [{
        link: 'https://ec.europa.eu/competition/antitrust/cases/dec_docs/37990/37990_3581_18.pdf',
        category: PROHIBITION, language: 'EN', date: '2009-05-13',
      }],
    })]);

    const [decision] = index.find('AT.37990');
    assert.equal(decision.url, 'https://ec.europa.eu/competition/antitrust/cases/dec_docs/37990/37990_3581_18.pdf');
    assert.equal(decision.language, 'EN');
    assert.equal(decision.documentDate, '2009-05-13');
    assert.match(decision.description, /Prohibition Decision/);
  });

  test('COMP/ is dropped, because the register numbers the case without it', () => {
    const index = buildCommissionCaseIndex([dataset({
      'M.8713': [{ link: 'https://ec.europa.eu/competition/mergers/cases1/20214/m8713_5752_3.pdf', category: ['x', 'Decision - web publication'] }],
    })]);

    assert.equal(index.find('COMP/M.8713').length, 1);
    assert.equal(index.find('m.8713').length, 1, 'and the number is not case-sensitive');
  });

  test('a case the dataset does not name yields nothing rather than a guess', () => {
    const index = buildCommissionCaseIndex([dataset({ 'AT.37990': [{ link: 'https://x.test/a.pdf', category: PROHIBITION }] })]);
    assert.deepEqual(index.find('AT.40178'), []);
  });

  test('a case filed only under a qualified number is still reached', () => {
    // `M.8181` — Merck / Sigma-Aldrich, cited by paragraph in real footnotes — exists in the
    // register only as `M.8181.AP`, between an ordinary `M.8180` and `M.8182`. 17 merger
    // cases are filed this way and in every one the plain number is absent with exactly one
    // suffixed sibling, so this resolves nothing that was in doubt.
    const index = buildCommissionCaseIndex([dataset({
      'M.8181.AP': [{ link: 'https://ec.europa.eu/competition/mergers/cases/m8181.pdf', category: ['x', 'Decision - web publication'] }],
    })]);

    assert.equal(index.find('M.8181').length, 1);
    assert.equal(index.find('M.8181.AP').length, 1, 'and the qualified number still works directly');
  });

  test('two qualified siblings are an ambiguity, not a pick', () => {
    const index = buildCommissionCaseIndex([dataset({
      'M.9000.AP': [{ link: 'https://ec.europa.eu/competition/mergers/a.pdf', category: ['x', 'Decision - web publication'] }],
      'M.9000.BP': [{ link: 'https://ec.europa.eu/competition/mergers/b.pdf', category: ['x', 'Decision - web publication'] }],
    })]);

    assert.deepEqual(index.find('M.9000'), [], 'neither is offered, because the number does not say which');
  });
});

/**
 * Cases as the register titles them, which is what a citation's name is checked against.
 *
 * Titles and numbers from the merger dataset as measured on 2026-09-16. `metadata` is a plain
 * object there; one case here carries it encoded, since other fields of the same files arrive
 * that way.
 */
const titledDataset = (cases: Record<string, { title: string; decided?: boolean }>) => JSON.stringify(
  Object.fromEntries(Object.entries(cases).map(([number, { title, decided }], at) => [number, {
    metadata: at === 0 ? JSON.stringify({ caseTitle: [title] }) : { caseTitle: [title] },
    decisions: decided === false ? [] : [{ decisionAttachments: [attachment({
      link: `https://ec.europa.eu/competition/mergers/cases/decisions/${number.toLowerCase()}.pdf`,
      category: ['DocumentCategory0587', 'Decision - web publication'],
    })] }],
  }])),
);

const REGISTER = titledDataset({
  'M.7967': { title: 'APAX PARTNERS / NEUBERGER BERMAN / ENGINEERING' },
  'M.7567': { title: 'BALL / REXAM' },
  'M.8048': { title: 'ARDAGH / BALL REXAM DIVESTMENT BUSINESS' },
  'M.8677': { title: 'SIEMENS / ALSTOM' },
  'M.3148': { title: 'SIEMENS / ALSTOM GAS AND STEAM TURBINES' },
  'M.9596': { title: 'ENGIE / PREDICA / OMNES / LANGA', decided: false },
  'M.9569': { title: 'ESSILORLUXOTTICA / GRANDVISION' },
  'M.1616': { title: 'ANTONIO DE SOMMER CHAMPALIMAUD / BANCO SANTANDER CENTRAL HISPANOAMERICANO' },
  'M.12052.AP': { title: 'UNICREDIT / BANCO BPM (Art. 21(4))', decided: false },
  'M.4005': { title: 'OTHER / PARTIES' },
  'M.4004': { title: 'ACME / WIDGETS' },
  'M.4006': { title: 'ACME / WIDGETS' },
});

describe('the case a citation names, when its number is another', () => {
  test('the register title is kept for every case, decided or not', () => {
    const index = buildCommissionCaseIndex([REGISTER]);
    assert.equal(index.title('M.7567'), 'BALL / REXAM');
    assert.equal(index.title('COMP/M.7967'), 'APAX PARTNERS / NEUBERGER BERMAN / ENGINEERING', 'the encoded metadata too');
    assert.equal(index.title('M.9596'), 'ENGIE / PREDICA / OMNES / LANGA', 'a case with no decision still has a title');
    assert.equal(index.title('M.12052'), 'UNICREDIT / BANCO BPM (Art. 21(4))', 'and a case filed only under a qualified number');
    assert.equal(index.title('M.1'), undefined);
  });

  test('a name agrees with its title on one word, which is what a shortened or misspelt name keeps', () => {
    assert.equal(caseNamesAgree('BSCH/Champalimaud', 'ANTONIO DE SOMMER CHAMPALIMAUD / BANCO SANTANDER CENTRAL HISPANOAMERICANO'), true);
    assert.equal(caseNamesAgree('Boeing/Sprit', 'BOEING / SPIRIT'), true);
    assert.equal(caseNamesAgree('Telefónica UK/Vodafone UK/Everything Everywhere/JV', 'TELEFONICA UK / VODAFONE UK / EVERYTHING EVERYWHERE / JV'), true);
    assert.equal(caseNamesAgree('Essilorluxottica/Grandvision', 'ESSILOR LUXOTTICA / GRAND VISION'), true, 'written run together');
    assert.equal(caseNamesAgree('Ball/Rexam', 'APAX PARTNERS / NEUBERGER BERMAN / ENGINEERING'), false);
    assert.equal(caseNamesAgree('JV', 'ANYTHING'), true, 'a name with nothing comparable in it is no evidence against the number');
  });

  test('a number filed as another case is taken for the case the citation names, and says so', () => {
    // Footnote 33 of the Commission's 2026 draft merger guidelines.
    const index = buildCommissionCaseIndex([REGISTER]);
    assert.deepEqual(identifyCommissionCase(index, 'M.7967', 'Ball/Rexam'), {
      caseNumber: 'M.7567', title: 'BALL / REXAM',
      numberMismatch: { cited: 'M.7967', citedTitle: 'APAX PARTNERS / NEUBERGER BERMAN / ENGINEERING', name: 'Ball/Rexam' },
    });
  });

  test('the case whose title is the name, not one whose title merely contains it', () => {
    const index = buildCommissionCaseIndex([REGISTER]);
    assert.equal(identifyCommissionCase(index, 'M.7967', 'Ball/Rexam').caseNumber, 'M.7567', 'not ARDAGH / BALL REXAM DIVESTMENT BUSINESS');
    // Footnote 108: a number the register has never used. SIEMENS / ALSTOM, not the 2003 turbines case.
    assert.deepEqual(identifyCommissionCase(index, 'M.9376', 'Siemens/Alstom'), {
      caseNumber: 'M.8677', title: 'SIEMENS / ALSTOM', numberMismatch: { cited: 'M.9376', name: 'Siemens/Alstom' },
    });
  });

  test('a number filed as a case with no decision is corrected all the same', () => {
    const index = buildCommissionCaseIndex([REGISTER]);
    assert.equal(identifyCommissionCase(index, 'M.9596', 'Essilorluxottica/Grandvision').caseNumber, 'M.9569');
  });

  test('where no single case carries the name, nothing is offered in its place', () => {
    const index = buildCommissionCaseIndex([REGISTER]);
    assert.deepEqual(identifyCommissionCase(index, 'M.7967', 'Nonexistent/Parties'), {
      numberMismatch: { cited: 'M.7967', citedTitle: 'APAX PARTNERS / NEUBERGER BERMAN / ENGINEERING', name: 'Nonexistent/Parties' },
    });
    // Two cases titled alike, equally far from the number cited: which one is not the index's to say.
    const tied = identifyCommissionCase(index, 'M.4005', 'Acme/Widgets');
    assert.equal(tied.caseNumber, undefined);
    assert.equal(tied.numberMismatch?.citedTitle, 'OTHER / PARTIES');
    // A number the register does not hold, and a name no single case carries, is not evidence
    // of a mistake: the data can simply be behind. Taken as cited, as it always was.
    assert.deepEqual(identifyCommissionCase(index, 'M.4999', 'Acme/Widgets'), { caseNumber: 'M.4999' });
  });

  test('a name that agrees, or no name at all, is the case as cited', () => {
    const index = buildCommissionCaseIndex([REGISTER]);
    assert.deepEqual(identifyCommissionCase(index, 'M.1616', 'BSCH/Champalimaud'),
      { caseNumber: 'M.1616', title: 'ANTONIO DE SOMMER CHAMPALIMAUD / BANCO SANTANDER CENTRAL HISPANOAMERICANO' });
    assert.deepEqual(identifyCommissionCase(index, 'M.12052', 'UniCredit/Banco BPM'), { caseNumber: 'M.12052', title: 'UNICREDIT / BANCO BPM (Art. 21(4))' });
    assert.deepEqual(identifyCommissionCase(index, 'M.7967', undefined), { caseNumber: 'M.7967', title: 'APAX PARTNERS / NEUBERGER BERMAN / ENGINEERING' });
  });

  test('a case the index has decisions for but no title is taken as cited, having nothing to check against', () => {
    const index = buildCommissionCaseIndex([dataset({ 'AT.37990': [{ link: 'https://ec.europa.eu/competition/antitrust/intel.pdf', category: PROHIBITION }] })]);
    assert.deepEqual(identifyCommissionCase(index, 'AT.37990', 'Intel'), { caseNumber: 'AT.37990', title: undefined });
  });
});

describe('telling a decision from the rest of the case file', () => {
  test('a document the register categorises as something else is never offered', () => {
    // Measured across the real datasets: against the decisions sit 3,836 `Description of the
    // concentration`, 2,752 `Section 1.2 of Form CO`, 97 `Initiation of proceedings Notice`
    // and 8 `Press Release / Memo`. Showing a lawyer a party's own form under the citation
    // they wrote is the failure this whole tool exists to prevent.
    const index = buildCommissionCaseIndex([dataset({
      'M.1000': [
        { link: 'https://ec.europa.eu/competition/mergers/cases/form.pdf', category: ['a', 'Section 1.2 of Form CO'] },
        { link: 'https://ec.europa.eu/competition/mergers/cases/desc.pdf', category: ['b', 'Description of the concentration'] },
        { link: 'https://ec.europa.eu/competition/mergers/cases/press.pdf', category: ['c', 'Press Release / Memo'] },
        { link: 'https://ec.europa.eu/competition/mergers/cases/notice.pdf', category: ['d', 'Initiation of proceedings Notice (Art. 11(6))'] },
      ],
    })]);

    assert.deepEqual(index.find('M.1000'), []);
  });

  test('an uncategorised merger decision is reached through the marker instead', () => {
    // 6,757 merger attachments carry no category at all — every one a PDF, 6,744 of them
    // under `mergers/cases/decisions/`. Requiring a category dropped M.8181, M.2027 and every
    // merger decided before the register began categorising.
    const index = buildCommissionCaseIndex([dataset({
      'M.2027': [{
        link: 'https://ec.europa.eu/competition/mergers/cases/decisions/m2027_de.pdf',
        name: 'Art. 6(1)(b) -  - mtf-dec-m-02027-020-1-20000713-0310-pub-de',
        language: 'DE', metadataType: 'METADATA_DECISION_ATTACHMENT',
      }],
    })]);

    const [decision] = index.find('M.2027');
    assert.equal(decision.url, 'https://ec.europa.eu/competition/mergers/cases/decisions/m2027_de.pdf');
    assert.equal(decision.description, 'Art. 6(1)(b)', 'the legal basis is what names these');
  });

  test('the marker cannot rescue a document the register positively called something else', () => {
    // The marker sits on categorised attachments too, including ones categorised by country
    // (36 `United Kingdom`, 31 `Germany`). A present category is therefore the answer and the
    // marker is consulted only in its absence — otherwise the marker would readmit every
    // Form CO section in the file.
    const index = buildCommissionCaseIndex([dataset({
      'M.1001': [{
        link: 'https://ec.europa.eu/competition/mergers/cases/form.pdf',
        category: ['a', 'Section 1.2 of Form CO'], metadataType: 'METADATA_DECISION_ATTACHMENT',
      }],
    })]);

    assert.deepEqual(index.find('M.1001'), []);
  });

  test('an attachment with neither a category nor the marker is refused', () => {
    const index = buildCommissionCaseIndex([dataset({
      'M.1002': [{ link: 'https://ec.europa.eu/competition/x.pdf', metadataType: 'METADATA_CASE_ATTACHMENT' }],
    })]);

    assert.deepEqual(index.find('M.1002'), []);
  });
});

describe('a case decided more than once', () => {
  test('both decisions are offered, the original first', () => {
    // Intel is the case in point, and 52 of the 360 antitrust cases carrying a decision have
    // two or more distinct decision dates. `AT.37990` holds the prohibition decision of
    // 13 May 2009 and its re-adoption of 22 September 2023, labelled identically. A footnote
    // citing paragraph 1000 means the text its author read, and the citation does not say
    // which — so both are returned, dated, rather than one of them chosen silently.
    const index = buildCommissionCaseIndex([dataset({
      'AT.37990': [
        { link: 'https://ec.europa.eu/competition/antitrust/cases1/202346/AT_37990_9687627_5129_3.pdf', category: PROHIBITION, language: 'EN', date: '2023-09-22' },
        { link: 'https://ec.europa.eu/competition/antitrust/cases/dec_docs/37990/37990_3581_18.pdf', category: PROHIBITION, language: 'EN', date: '2009-05-13' },
      ],
    })]);

    const found = index.find('AT.37990');
    assert.equal(found.length, 2);
    assert.equal(found[0].documentDate, '2009-05-13', 'the decision the footnote was written against leads');
    assert.equal(found[1].documentDate, '2023-09-22');
  });

  test('the language the pane reads comes first', () => {
    const index = buildCommissionCaseIndex([dataset({
      'AT.100': [
        { link: 'https://ec.europa.eu/competition/fr.pdf', category: PROHIBITION, language: 'FR', date: '2009-05-13' },
        { link: 'https://ec.europa.eu/competition/en.pdf', category: PROHIBITION, language: 'EN', date: '2009-05-13' },
      ],
    })]);

    assert.equal(index.find('AT.100')[0].language, 'EN');
  });

  test('a provisional version never outranks the final text', () => {
    const index = buildCommissionCaseIndex([dataset({
      'AT.101': [
        { link: 'https://ec.europa.eu/competition/prov.pdf', category: ['a', 'Provisional non-confidential version of the decision'], language: 'EN', date: '2020-01-01' },
        { link: 'https://ec.europa.eu/competition/final.pdf', category: PROHIBITION, language: 'EN', date: '2021-01-01' },
      ],
    })]);

    const found = index.find('AT.101');
    assert.equal(found[0].url, 'https://ec.europa.eu/competition/final.pdf');
    assert.equal(found.length, 2, 'but the provisional text is still offered rather than hidden');
  });

  test('one document listed under two decisions is one entry', () => {
    const shared = 'https://ec.europa.eu/competition/antitrust/shared.pdf';
    const index = buildCommissionCaseIndex([dataset({
      'AT.102': [
        { link: shared, category: PROHIBITION, language: 'EN', date: '2020-01-01' },
        { link: shared, category: PROHIBITION, language: 'EN', date: '2020-01-01' },
      ],
    })]);

    assert.equal(index.find('AT.102').length, 1);
  });
});

describe('what the index refuses to carry', () => {
  test('a link that is not an https PDF is not an official source', () => {
    const index = buildCommissionCaseIndex([dataset({
      'AT.200': [
        { link: 'http://ec.europa.eu/competition/insecure.pdf', category: PROHIBITION },
        { link: 'https://ec.europa.eu/competition/case-page', category: PROHIBITION },
      ],
    })]);

    assert.deepEqual(index.find('AT.200'), []);
  });

  test('a dataset that cannot be parsed leaves the others standing', () => {
    // A failed download must cost the register link and nothing else — never a lookup.
    const good = dataset({ 'AT.201': [{ link: 'https://ec.europa.eu/competition/a.pdf', category: PROHIBITION }] });
    const index = buildCommissionCaseIndex(['<html>not json at all</html>', good, '[1,2,3]']);

    assert.equal(index.size, 1);
    assert.equal(index.find('AT.201').length, 1);
  });

  test('an empty set of datasets is an empty index, not a throw', () => {
    const index = buildCommissionCaseIndex([]);
    assert.equal(index.size, 0);
    assert.deepEqual(index.find('AT.37990'), []);
  });
});

describe('keeping the index without ever failing a lookup', () => {
  const body = () => dataset({ 'AT.37990': [{ link: 'https://ec.europa.eu/competition/a.pdf', category: PROHIBITION }] });

  /** A fetcher that replays queued bodies and counts what it was asked for. */
  function stub(bodies: Array<string | Error>) {
    const urls: string[] = [];
    const fetcher = (async (url: string) => {
      urls.push(String(url));
      const next = bodies.shift();
      if (next instanceof Error) throw next;
      if (next === undefined) return new Response('', { status: 503 });
      return new Response(next, { status: 200 });
    }) as unknown as typeof fetch;
    return { fetcher, urls };
  }

  test('downloads once for callers that arrive together', async () => {
    // A competition memo can put twenty Commission citations in flight at the same moment.
    // Without a single in-flight build each one would fetch 42MB of its own.
    const { fetcher, urls } = stub([body(), body()]);
    const loader = createCommissionCaseIndexLoader({ fetcher });

    const results = await Promise.all([loader.get(), loader.get(), loader.get()]);

    assert.equal(urls.length, 2, 'the two datasets, once each');
    for (const index of results) assert.equal(index.find('AT.37990').length, 1);
  });

  test('a dataset that will not download leaves the register link standing', async () => {
    // The floor is what Ibid does today. Retrieval of a decision is layered on top of it and
    // must never take it away: a failed download is an empty index, never a failed lookup.
    const { fetcher } = stub([new Error('ECONNRESET'), new Error('ECONNRESET')]);
    const loader = createCommissionCaseIndexLoader({ fetcher });

    const index = await loader.get();
    assert.equal(index.size, 0);
    assert.deepEqual(index.find('AT.37990'), []);
  });

  test('one dataset failing still indexes the other', async () => {
    const { fetcher } = stub([new Error('down'), body()]);
    const loader = createCommissionCaseIndexLoader({ fetcher });

    assert.equal((await loader.get()).find('AT.37990').length, 1);
  });

  test('the index is not rebuilt until it is old', async () => {
    let clock = 1_000;
    const { fetcher, urls } = stub([body(), body(), body(), body()]);
    const loader = createCommissionCaseIndexLoader({ fetcher, now: () => clock, refreshMs: 1_000 });

    await loader.get();
    clock += 500;
    await loader.get();
    assert.equal(urls.length, 2, 'still the first build');

    clock += 600;
    await loader.get();
    assert.equal(urls.length, 4, 'rebuilt once it aged past the interval');
  });

  test('a failed refresh keeps the index already held', async () => {
    let clock = 1_000;
    const { fetcher } = stub([body(), body(), new Error('down'), new Error('down')]);
    const loader = createCommissionCaseIndexLoader({ fetcher, now: () => clock, refreshMs: 1_000 });

    await loader.get();
    clock += 5_000;

    const index = await loader.get();
    assert.equal(index.find('AT.37990').length, 1, 'the previous index is still the answer');
  });

  test('identifies itself when it is told how', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetcher = (async (_url: string, init: RequestInit = {}) => {
      seen.push((init.headers ?? {}) as Record<string, string>);
      return new Response(body(), { status: 200 });
    }) as unknown as typeof fetch;

    await createCommissionCaseIndexLoader({ fetcher, userAgent: 'Ibid/0.1 (+mailto:someone@example.test)' }).get();

    assert.equal(seen[0]['User-Agent'], 'Ibid/0.1 (+mailto:someone@example.test)');
  });
});
