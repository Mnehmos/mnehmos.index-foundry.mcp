/**
 * Hybrid Search Tests
 *
 * These exercise the retrieval code that actually ships: src/templates/server/search.ts
 * is copied verbatim into every exported project, and is imported here directly.
 * There is no test-only search implementation.
 *
 * Semantic search is made deterministic and offline by giving each fixture chunk
 * a unit vector on its own concept axis and injecting a fake `embed` that maps a
 * query to the concept a real embedding model would put it near. That is what
 * lets these tests assert the thing that matters: a query with no lexical overlap
 * with its target chunk still retrieves it.
 */

import { describe, it, expect, beforeAll, afterAll, vi, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

import {
  buildSearchContext,
  searchKeyword,
  searchSemantic,
  searchHybrid,
  runSearch,
  detectAnchorTerms,
  calculateQuerySpecificity,
  applyAnchorBoost,
  cosineSimilarity,
  RRF_CONSTANT,
  type Chunk,
  type Vector,
} from '../src/templates/server/search.js';

// ============================================================================
// Test Fixtures - D&D Content Samples
// ============================================================================

const D50_ROOM_CONTENT = `D50: The Chamber of Binding
This circular chamber has a 30-foot ceiling. Ancient runes cover the walls,
glowing with a faint blue luminescence. In the center stands a stone pedestal
with manacles attached. The air feels thick with arcane energy.

Creatures: 2 Shadow Demons (CR 4) lurk in the darkness near the ceiling.
They attack anyone who disturbs the pedestal.

Trap: The manacles are cursed. Anyone who touches them must make a DC 16
Wisdom save or become paralyzed for 1 minute.

Treasure: Hidden compartment (DC 20 Investigation) contains a Ring of Protection +1.`;

const D55_ROOM_CONTENT = `D55: The Sunken Library
Water covers the floor of this room to a depth of 2 feet. Ruined bookshelves
line the walls, their contents mostly destroyed by moisture.

Creatures: 3 Water Weirds inhabit the flooded chamber.
They remain hidden until a creature enters the water.

Hazard: The water is electrified by a trapped lightning glyph.
Creatures in the water when activated take 4d6 lightning damage (DC 14 Dex half).

Loot: One waterproof scroll case contains a Scroll of Water Breathing.`;

const SRD_ABOLETH_CONTENT = `Aboleth
Large aberration, lawful evil

Armor Class 17 (natural armor)
Hit Points 135 (18d10 + 36)
Speed 10 ft., swim 40 ft.

Saving Throws Con +6, Int +8, Wis +6
Senses darkvision 120 ft., passive Perception 20
Languages Deep Speech, telepathy 120 ft.
Challenge 10 (5,900 XP)

Amphibious. The aboleth can breathe air and water.`;

const SRD_BEHOLDER_CONTENT = `Beholder
Large aberration, lawful evil

Armor Class 18 (natural armor)
Hit Points 180 (19d10 + 76)
Speed 0 ft., fly 20 ft. (hover)

Senses darkvision 120 ft., passive Perception 22
Challenge 13 (10,000 XP)

Antimagic Cone. The beholder's central eye creates an area of antimagic,
as in the antimagic field spell, in a 150-foot-cone.`;

// ============================================================================
// Deterministic embedding fixtures
// ============================================================================

/**
 * Concept axes. Each fixture chunk sits on exactly one, so cosine similarity
 * between a query vector and a chunk vector is 1 for the intended match and 0
 * otherwise - a clean stand-in for a real embedding space.
 */
const CONCEPTS = ['d50', 'd55', 'aboleth', 'beholder', 'wld-intro', 'srd-intro'] as const;
type Concept = (typeof CONCEPTS)[number];

function conceptVector(concept: Concept): number[] {
  return CONCEPTS.map((c) => (c === concept ? 1 : 0));
}

/** Blend two concepts, for queries that are genuinely between topics. */
function blendedVector(a: Concept, b: Concept, weightA = 0.7): number[] {
  const va = conceptVector(a);
  const vb = conceptVector(b);
  return va.map((v, i) => v * weightA + vb[i] * (1 - weightA));
}

const CHUNK_CONCEPTS: Array<{ chunk: Chunk; concept: Concept }> = [
  {
    concept: 'd50',
    chunk: {
      chunk_id: 'chunk-d50-001',
      source_id: 'wld-source',
      text: D50_ROOM_CONTENT,
      position: { index: 300, start_char: 0, end_char: D50_ROOM_CONTENT.length },
      metadata: { source_name: "World's Largest Dungeon", room: 'D50' },
    },
  },
  {
    concept: 'd55',
    chunk: {
      chunk_id: 'chunk-d55-001',
      source_id: 'wld-source',
      text: D55_ROOM_CONTENT,
      position: { index: 305, start_char: 0, end_char: D55_ROOM_CONTENT.length },
      metadata: { source_name: "World's Largest Dungeon", room: 'D55' },
    },
  },
  {
    concept: 'aboleth',
    chunk: {
      chunk_id: 'chunk-aboleth-001',
      source_id: 'srd-source',
      text: SRD_ABOLETH_CONTENT,
      position: { index: 10, start_char: 0, end_char: SRD_ABOLETH_CONTENT.length },
      metadata: { source_name: 'SRD 5.2', creature: 'Aboleth' },
    },
  },
  {
    concept: 'beholder',
    chunk: {
      chunk_id: 'chunk-beholder-001',
      source_id: 'srd-source',
      text: SRD_BEHOLDER_CONTENT,
      position: { index: 15, start_char: 0, end_char: SRD_BEHOLDER_CONTENT.length },
      metadata: { source_name: 'SRD 5.2', creature: 'Beholder' },
    },
  },
  {
    concept: 'wld-intro',
    chunk: {
      chunk_id: 'chunk-intro-001',
      source_id: 'wld-source',
      text: "Welcome to the World's Largest Dungeon, a massive adventure for characters level 1-20.",
      position: { index: 0, start_char: 0, end_char: 86 },
      metadata: { source_name: "World's Largest Dungeon" },
    },
  },
  {
    concept: 'srd-intro',
    chunk: {
      chunk_id: 'chunk-srd-intro-001',
      source_id: 'srd-source',
      text: "System Reference Document 5.2 contains the core rules for the world's greatest roleplaying game.",
      position: { index: 0, start_char: 0, end_char: 96 },
      metadata: { source_name: 'SRD 5.2' },
    },
  },
];

const testChunks: Chunk[] = CHUNK_CONCEPTS.map((c) => c.chunk);

const testVectors: Vector[] = CHUNK_CONCEPTS.map(({ chunk, concept }) => ({
  chunk_id: chunk.chunk_id,
  embedding: conceptVector(concept),
  model: 'text-embedding-3-small',
}));

/**
 * Stands in for the embedding model: maps a natural-language query onto the
 * concept a real model would place it near. Queries deliberately share no
 * keywords with their target chunk.
 */
const QUERY_CONCEPTS: Array<{ match: RegExp; vector: () => number[] }> = [
  { match: /cursed restraints|paralyz|shackle/i, vector: () => conceptVector('d50') },
  { match: /demons lurking|darkness|shadow/i, vector: () => conceptVector('d50') },
  { match: /chamber of binding|binding/i, vector: () => conceptVector('d50') },
  { match: /flooded library|sunken|bookshel/i, vector: () => conceptVector('d55') },
  { match: /underwater electricity|lightning trap|electrified/i, vector: () => conceptVector('d55') },
  { match: /telepathic aberration|psychic/i, vector: () => conceptVector('aboleth') },
  { match: /underwater.*monster|amphibious/i, vector: () => conceptVector('aboleth') },
  { match: /floating eye|eye tyrant/i, vector: () => conceptVector('beholder') },
  { match: /antimagic/i, vector: () => conceptVector('beholder') },
  { match: /underwater/i, vector: () => blendedVector('aboleth', 'd55') },
];

function fakeEmbed(query: string): Promise<number[]> {
  for (const { match, vector } of QUERY_CONCEPTS) {
    if (match.test(query)) return Promise.resolve(vector());
  }
  // Unknown query: equidistant from everything, so keyword drives the result.
  return Promise.resolve(CONCEPTS.map(() => 0.1));
}

const ctx = buildSearchContext(testChunks, testVectors);
const topIds = (results: Array<{ chunk: Chunk }>) => results.map((r) => r.chunk.chunk_id);

// ============================================================================

describe('Hybrid Search', () => {
  describe('Semantic retrieval without lexical overlap', () => {
    // Each of these queries shares no meaningful keyword with its target chunk.
    // Keyword search alone cannot find them; this is the regression the hybrid
    // path exists to prevent.
    const cases: Array<{ query: string; expected: string; label: string }> = [
      { label: 'D50 via "cursed restraints"', query: 'cursed restraints', expected: 'chunk-d50-001' },
      { label: 'D50 via "demons lurking in darkness"', query: 'demons lurking in darkness', expected: 'chunk-d50-001' },
      { label: 'D55 via "flooded library"', query: 'flooded library', expected: 'chunk-d55-001' },
      { label: 'D55 via "underwater electricity trap"', query: 'underwater electricity trap', expected: 'chunk-d55-001' },
      { label: 'Aboleth via "telepathic aberration"', query: 'telepathic aberration', expected: 'chunk-aboleth-001' },
      { label: 'Beholder via "floating eye tyrant"', query: 'floating eye tyrant', expected: 'chunk-beholder-001' },
      { label: 'Beholder via "antimagic field eye"', query: 'creature with antimagic field eye', expected: 'chunk-beholder-001' },
    ];

    for (const { query, expected, label } of cases) {
      it(`retrieves ${label}`, async () => {
        const { results, diagnostics } = await searchHybrid(ctx, query, 3, fakeEmbed);

        expect(diagnostics.mode).toBe('hybrid');
        expect(topIds(results)).toContain(expected);
        expect(results[0].chunk.chunk_id).toBe(expected);
      });
    }

    it('beats keyword-only search on a purely semantic query', async () => {
      // "psychic" appears nowhere in the Aboleth chunk, so keyword search has
      // nothing to match on; only the semantic half can find it.
      const query = 'psychic domination';

      const keywordOnly = searchKeyword(ctx, query, 3);
      const { results: hybrid } = await searchHybrid(ctx, query, 3, fakeEmbed);

      expect(topIds(keywordOnly)).not.toContain('chunk-aboleth-001');
      expect(topIds(hybrid)).toContain('chunk-aboleth-001');
    });
  });

  describe('Keyword search', () => {
    it('scores by the fraction of query terms present', () => {
      const results = searchKeyword(ctx, 'water lightning', 5);
      expect(results[0].chunk.chunk_id).toBe('chunk-d55-001');
      expect(results[0].score).toBe(1); // both terms present
    });

    it('returns nothing for an empty query', () => {
      expect(searchKeyword(ctx, '', 5)).toEqual([]);
      expect(searchKeyword(ctx, '   ', 5)).toEqual([]);
    });

    it('excludes chunks with no matching terms', () => {
      const results = searchKeyword(ctx, 'beholder', 10);
      expect(topIds(results)).toEqual(['chunk-beholder-001']);
    });
  });

  describe('Semantic search', () => {
    it('ranks by cosine similarity to the query vector', () => {
      const results = searchSemantic(ctx, conceptVector('beholder'), 3);
      expect(results[0].chunk_id).toBe('chunk-beholder-001');
      expect(results[0].score).toBeCloseTo(1, 5);
      expect(results[1].score).toBeCloseTo(0, 5);
    });

    it('returns nothing for an empty vector', () => {
      expect(searchSemantic(ctx, [], 5)).toEqual([]);
    });

    it('treats mismatched dimensions as zero similarity', () => {
      expect(cosineSimilarity([1, 0, 0], [1, 0])).toBe(0);
    });

    it('treats a zero vector as zero similarity rather than NaN', () => {
      expect(cosineSimilarity([0, 0, 0], [1, 2, 3])).toBe(0);
    });
  });

  describe('Anchor terms', () => {
    it('detects room codes, long numbers and quoted phrases', () => {
      expect(detectAnchorTerms('what is in D50')).toContain('D50');
      expect(detectAnchorTerms('page 300 of the dungeon')).toContain('300');
      expect(detectAnchorTerms('tell me about "myrmarch"')).toContain('myrmarch');
    });

    it('dedupes repeated anchors', () => {
      expect(detectAnchorTerms('D50 and D50 again')).toEqual(['D50']);
    });

    it('boosts an exact identifier match above a bare mention', () => {
      const withColon: Chunk = { ...testChunks[0] };            // contains "D50:"
      const bareMention: Chunk = {
        ...testChunks[1],
        chunk_id: 'bare',
        text: 'The corridor leads onward toward D50 eventually.',
      };

      const boosted = applyAnchorBoost(
        [
          { chunk: bareMention, score: 0.5 },
          { chunk: withColon, score: 0.5 },
        ],
        ['D50']
      );

      // "D50:" earns the 0.4 exact-pattern boost; the bare mention earns 0.15.
      expect(boosted[0].chunk.chunk_id).toBe('chunk-d50-001');
      expect(boosted[0].score).toBeCloseTo(0.9, 5);
      expect(boosted[1].score).toBeCloseTo(0.65, 5);
    });

    it('leaves results untouched when there are no anchors', () => {
      const input = [{ chunk: testChunks[0], score: 0.5 }];
      expect(applyAnchorBoost(input, [])).toBe(input);
    });

    it('ranks the anchored chunk first in a full hybrid search', async () => {
      const { results, diagnostics } = await searchHybrid(ctx, 'what happens in D50', 3, fakeEmbed);
      expect(diagnostics.anchorTerms).toContain('D50');
      expect(results[0].chunk.chunk_id).toBe('chunk-d50-001');
    });
  });

  describe('Adaptive weighting', () => {
    it('weights keyword search more heavily as anchors accumulate', async () => {
      // One anchor lands exactly at parity (0.3 + 0.2); two tips it to 0.7.
      const one = await searchHybrid(ctx, 'D50', 3, fakeEmbed);
      expect(one.diagnostics.keywordWeight).toBeCloseTo(0.5, 10);

      const two = await searchHybrid(ctx, 'compare D50 and D55', 3, fakeEmbed);
      expect(two.diagnostics.anchorTerms).toEqual(expect.arrayContaining(['D50', 'D55']));
      expect(two.diagnostics.keywordWeight).toBeCloseTo(0.7, 10);
      expect(two.diagnostics.keywordWeight).toBeGreaterThan(two.diagnostics.semanticWeight);
    });

    it('weights semantic search more heavily for short specific non-anchor queries', async () => {
      const { diagnostics } = await searchHybrid(ctx, 'ancient glowing runes', 3, fakeEmbed);
      expect(diagnostics.specificity).toBeGreaterThan(0);
      expect(diagnostics.semanticWeight).toBeGreaterThan(diagnostics.keywordWeight);
    });

    it('stays balanced for long broad queries with no anchors', async () => {
      const { diagnostics } = await searchHybrid(
        ctx,
        'tell me about what kind of creatures live in the dungeon',
        3,
        fakeEmbed
      );
      // Broad words cancel the length signal, leaving specificity at 0.
      expect(diagnostics.specificity).toBe(0);
      expect(diagnostics.keywordWeight).toBeCloseTo(0.5, 10);
      expect(diagnostics.semanticWeight).toBeCloseTo(0.5, 10);
    });

    it('scores broad "what/how/about" queries as less specific', () => {
      const broad = calculateQuerySpecificity('tell me about the dungeon layout please', []);
      const specific = calculateQuerySpecificity('D50 manacles', ['D50']);
      expect(specific).toBeGreaterThan(broad);
    });

    it('keeps weights summing to 1', async () => {
      const { diagnostics } = await searchHybrid(ctx, 'anything at all', 3, fakeEmbed);
      expect(diagnostics.keywordWeight + diagnostics.semanticWeight).toBeCloseTo(1, 10);
    });
  });

  describe('Degradation when embedding is unavailable', () => {
    it('falls back to keyword-only when embedding throws', async () => {
      const failing = () => Promise.reject(new Error('API key missing'));
      const { results, diagnostics } = await searchHybrid(ctx, 'water lightning', 3, failing);

      expect(diagnostics.mode).toBe('keyword');
      expect(results[0].chunk.chunk_id).toBe('chunk-d55-001');
    });

    it('does not call the embedder at all when there are no vectors', async () => {
      const noVectors = buildSearchContext(testChunks, []);
      const embed = vi.fn(fakeEmbed);

      const { diagnostics } = await searchHybrid(noVectors, 'water', 3, embed);

      expect(embed).not.toHaveBeenCalled();
      expect(diagnostics.mode).toBe('keyword');
    });

    it('still applies anchor boosting in the keyword-only path', async () => {
      const failing = () => Promise.reject(new Error('offline'));
      const { results } = await searchHybrid(ctx, 'D50 chamber', 3, failing);
      expect(results[0].chunk.chunk_id).toBe('chunk-d50-001');
    });
  });

  describe('runSearch (caller-supplied vector)', () => {
    it('uses keyword mode by default', () => {
      const results = runSearch(ctx, { query: 'beholder', mode: 'keyword', topK: 5 });
      expect(topIds(results)).toEqual(['chunk-beholder-001']);
    });

    it('throws when semantic mode is used without a vector', () => {
      expect(() => runSearch(ctx, { query: 'x', mode: 'semantic', topK: 5 })).toThrow(
        /query_vector required/
      );
    });

    it('falls back to keyword when hybrid mode is used without a vector', () => {
      const results = runSearch(ctx, { query: 'beholder', mode: 'hybrid', topK: 5 });
      expect(topIds(results)).toEqual(['chunk-beholder-001']);
    });

    it('fuses both lists with RRF when a vector is supplied', () => {
      const results = runSearch(ctx, {
        query: 'aboleth',
        queryVector: conceptVector('aboleth'),
        mode: 'hybrid',
        topK: 5,
      });

      expect(results[0].chunk.chunk_id).toBe('chunk-aboleth-001');
      // Rank 1 in both lists: 2 * 1/(60 + 0 + 1)
      expect(results[0].score).toBeCloseTo(2 / (RRF_CONSTANT + 1), 10);
    });

    it('uses k=60 as the RRF constant', () => {
      expect(RRF_CONSTANT).toBe(60);
    });
  });

  describe('Result shape', () => {
    it('returns the full chunk with each score', async () => {
      const { results } = await searchHybrid(ctx, 'flooded library', 2, fakeEmbed);

      expect(results.length).toBeGreaterThan(0);
      for (const r of results) {
        expect(r.chunk.chunk_id).toBeDefined();
        expect(r.chunk.text).toBeDefined();
        expect(r.chunk.source_id).toBeDefined();
        expect(r.chunk.position).toBeDefined();
        expect(typeof r.score).toBe('number');
        expect(Number.isNaN(r.score)).toBe(false);
      }
    });

    it('returns results in descending score order', async () => {
      const { results } = await searchHybrid(ctx, 'water creatures dungeon', 6, fakeEmbed);
      const scores = results.map((r) => r.score);
      expect(scores).toEqual([...scores].sort((a, b) => b - a));
    });

    it('respects topK', async () => {
      const { results } = await searchHybrid(ctx, 'dungeon', 2, fakeEmbed);
      expect(results.length).toBeLessThanOrEqual(2);
    });
  });

  describe('Edge cases', () => {
    it('handles an empty query without throwing', async () => {
      const { results } = await searchHybrid(ctx, '', 5, fakeEmbed);
      expect(Array.isArray(results)).toBe(true);
    });

    it('handles game-mechanics notation', async () => {
      const { results } = await searchHybrid(ctx, 'DC 16 Wisdom saving throw', 3, fakeEmbed);
      expect(topIds(results)).toContain('chunk-d50-001');
    });

    it('handles a very long query', async () => {
      const long = 'water '.repeat(200) + 'lightning';
      const { results } = await searchHybrid(ctx, long, 3, fakeEmbed);
      expect(results.length).toBeGreaterThan(0);
    });

    it('returns the same chunk for different phrasings of one question', async () => {
      const a = await searchHybrid(ctx, 'flooded library', 3, fakeEmbed);
      const b = await searchHybrid(ctx, 'the sunken bookshelves room', 3, fakeEmbed);
      expect(a.results[0].chunk.chunk_id).toBe('chunk-d55-001');
      expect(b.results[0].chunk.chunk_id).toBe('chunk-d55-001');
    });

    it('completes a small-corpus search well under 100ms', async () => {
      const start = performance.now();
      await searchHybrid(ctx, 'water lightning trap', 5, fakeEmbed);
      expect(performance.now() - start).toBeLessThan(100);
    });
  });
});

// ============================================================================
// Integration: the chat flow used by the exported server
// ============================================================================

describe('Chat flow integration', () => {
  const testProjectDir = path.join(process.cwd(), '.test-hybrid-search');
  const dataDir = path.join(testProjectDir, 'data');

  beforeAll(async () => {
    await fs.mkdir(dataDir, { recursive: true });

    await fs.writeFile(
      path.join(dataDir, 'chunks.jsonl'),
      testChunks.map((c) => JSON.stringify({ ...c, created_at: new Date().toISOString() })).join('\n'),
      'utf-8'
    );
    await fs.writeFile(
      path.join(dataDir, 'vectors.jsonl'),
      testVectors.map((v) => JSON.stringify({ ...v, created_at: new Date().toISOString() })).join('\n'),
      'utf-8'
    );
    await fs.writeFile(
      path.join(testProjectDir, 'project.json'),
      JSON.stringify(
        {
          project_id: 'test-dnd-chatbot',
          name: 'D&D Chatbot Test',
          embedding_model: {
            provider: 'openai',
            model_name: 'text-embedding-3-small',
            api_key_env: 'TEST_EMBEDDING_KEY',
          },
          chunk_config: { strategy: 'recursive', max_chars: 1500, overlap_chars: 150 },
          stats: { sources_count: 2, chunks_count: testChunks.length, vectors_count: testVectors.length },
        },
        null,
        2
      )
    );
    await fs.writeFile(
      path.join(testProjectDir, 'sources.jsonl'),
      [
        { source_id: 'wld-source', type: 'pdf', uri: 'wld.pdf', source_name: "World's Largest Dungeon", status: 'completed' },
        { source_id: 'srd-source', type: 'pdf', uri: 'srd-5.2.pdf', source_name: 'SRD 5.2', status: 'completed' },
      ]
        .map((s) => JSON.stringify(s))
        .join('\n'),
      'utf-8'
    );
  });

  afterAll(async () => {
    await fs.rm(testProjectDir, { recursive: true, force: true }).catch(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.TEST_EMBEDDING_KEY;
  });

  /** Intercept the embeddings HTTP call so no network request is made. */
  function stubEmbeddingApi(vector: number[]) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ data: [{ embedding: vector }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
      )
    );
  }

  it('uses hybrid search when an API key is configured', async () => {
    process.env.TEST_EMBEDDING_KEY = 'test-key';
    stubEmbeddingApi(conceptVector('aboleth'));

    const { chatWithHybridSearch } = await import('../src/tools/projects.js');
    const result = await chatWithHybridSearch({
      question: 'telepathic aberration',
      projectDir: testProjectDir,
      topK: 3,
    });

    expect(result.searchMode).toBe('hybrid');
    expect(result.sources[0].chunk_id).toBe('chunk-aboleth-001');
    expect(result.context).toContain('Aboleth');
  });

  it('honours the project\'s configured api_key_env, not a hardcoded one', async () => {
    // OPENAI_API_KEY deliberately unset; the project declares TEST_EMBEDDING_KEY.
    const previous = process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.TEST_EMBEDDING_KEY = 'test-key';
    stubEmbeddingApi(conceptVector('d55'));

    try {
      const { chatWithHybridSearch } = await import('../src/tools/projects.js');
      const result = await chatWithHybridSearch({
        question: 'flooded library',
        projectDir: testProjectDir,
        topK: 3,
      });

      expect(result.searchMode).toBe('hybrid');
      expect(result.sources[0].chunk_id).toBe('chunk-d55-001');
    } finally {
      if (previous !== undefined) process.env.OPENAI_API_KEY = previous;
    }
  });

  it('degrades to keyword search when no API key is present', async () => {
    delete process.env.TEST_EMBEDDING_KEY;

    const { chatWithHybridSearch } = await import('../src/tools/projects.js');
    const result = await chatWithHybridSearch({
      question: 'water lightning',
      projectDir: testProjectDir,
      topK: 3,
    });

    expect(result.searchMode).toBe('keyword');
    expect(result.sources[0].chunk_id).toBe('chunk-d55-001');
  });

  it('builds context with source separators', async () => {
    delete process.env.TEST_EMBEDDING_KEY;

    const { chatWithHybridSearch } = await import('../src/tools/projects.js');
    const result = await chatWithHybridSearch({
      question: 'water',
      projectDir: testProjectDir,
      topK: 3,
    });

    expect(result.context.length).toBeGreaterThan(0);
    if (result.sources.length > 1) {
      expect(result.context).toContain('---');
    }
  });

  it('throws a clear error for a missing project', async () => {
    const { chatWithHybridSearch } = await import('../src/tools/projects.js');
    await expect(
      chatWithHybridSearch({ question: 'x', projectDir: path.join(process.cwd(), '.no-such-project') })
    ).rejects.toThrow(/Project not found/);
  });
});

// ============================================================================
// The exported server template
// ============================================================================

describe('Exported server template', () => {
  it('is a real source file, not a generated string', async () => {
    const { generateMcpServerSourceForTest } = await import('../src/tools/projects.js');
    const source = generateMcpServerSourceForTest();

    // Delegates retrieval to the shared module rather than redefining it.
    expect(source).toContain('from "./search.js"');
    expect(source).toContain('searchHybrid');
    expect(source).not.toContain('function searchKeyword');
  });

  it('reads its embedding config at runtime instead of hardcoding a model', async () => {
    const { generateMcpServerSourceForTest } = await import('../src/tools/projects.js');
    const source = generateMcpServerSourceForTest();

    expect(source).toContain('embeddingModel.model_name');
    expect(source).toContain('process.env[embeddingModel.api_key_env]');
    // The regression this guards: a literal model name baked into the request.
    expect(source).not.toMatch(/model:\s*"text-embedding-3-small"/);
    // The LLM completion call may still default to OPENAI_API_KEY, but the
    // embedding path - the one that has to match the index - must not.
    const fnStart = source.indexOf('async function generateQueryEmbedding');
    const fnEnd = source.indexOf('// ====', fnStart);
    const embeddingFn = source.slice(fnStart, fnEnd);

    expect(embeddingFn).toContain('process.env[embeddingModel.api_key_env]');
    expect(embeddingFn).not.toContain('process.env.OPENAI_API_KEY');
  });

  it('warns when the index model and query model disagree', async () => {
    const { generateMcpServerSourceForTest } = await import('../src/tools/projects.js');
    expect(generateMcpServerSourceForTest()).toContain('WARNING: index was built with');
  });

  it('emits a runtime config carrying the export-time options', async () => {
    const { buildServerConfigForTest } = await import('../src/tools/projects.js');
    const config = JSON.parse(buildServerConfigForTest('my-server', 'My description', 9090, false));

    expect(config).toEqual({
      server_name: 'my-server',
      server_description: 'My description',
      port: 9090,
      include_http: false,
    });
  });
});
