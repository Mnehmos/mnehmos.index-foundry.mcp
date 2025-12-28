/**
 * Hybrid Search Chat Enhancement Tests
 *
 * These tests define the contract for hybrid search in the /chat endpoint.
 * Currently, the /chat endpoint uses keyword-only search (line 3148 in projects.ts),
 * which fails to retrieve:
 * - World's Largest Dungeon content after ~300 pages (D50, D55 rooms)
 * - SRD 5.2 creature stats despite being present in chunks
 *
 * Feature Requirements:
 * - generateQueryEmbedding() function to embed user questions
 * - /chat endpoint must use hybrid search (semantic + keyword)
 * - Template generator must produce hybrid search code
 *
 * Integration Points:
 * - src/tools/projects.ts - generateMcpServerSource function (line ~2559)
 * - Generated server src/index.ts - /chat endpoint
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

// ============================================================================
// Test Fixtures - D&D Content Samples
// ============================================================================

/**
 * Sample D50 room content from World's Largest Dungeon
 * This content uses D&D-specific terminology that keyword search misses
 */
const D50_ROOM_CONTENT = `D50: The Chamber of Binding
This circular chamber has a 30-foot ceiling. Ancient runes cover the walls, 
glowing with a faint blue luminescence. In the center stands a stone pedestal 
with manacles attached. The air feels thick with arcane energy.

Creatures: 2 Shadow Demons (CR 4) lurk in the darkness near the ceiling.
They attack anyone who disturbs the pedestal.

Trap: The manacles are cursed. Anyone who touches them must make a DC 16 
Wisdom save or become paralyzed for 1 minute.

Treasure: Hidden compartment (DC 20 Investigation) contains a Ring of Protection +1.`;

/**
 * Sample D55 room content  
 */
const D55_ROOM_CONTENT = `D55: The Sunken Library
Water covers the floor of this room to a depth of 2 feet. Ruined bookshelves 
line the walls, their contents mostly destroyed by moisture.

Creatures: 3 Water Weirds inhabit the flooded chamber.
They remain hidden until a creature enters the water.

Hazard: The water is electrified by a trapped lightning glyph.
Creatures in the water when activated take 4d6 lightning damage (DC 14 Dex half).

Loot: One waterproof scroll case contains a Scroll of Water Breathing.`;

/**
 * Sample SRD 5.2 creature content - Aboleth
 */
const SRD_ABOLETH_CONTENT = `Aboleth
Large aberration, lawful evil

Armor Class 17 (natural armor)
Hit Points 135 (18d10 + 36)
Speed 10 ft., swim 40 ft.

STR 21 (+5) DEX 9 (-1) CON 15 (+2) INT 18 (+4) WIS 15 (+2) CHA 18 (+4)

Saving Throws Con +6, Int +8, Wis +6
Skills History +12, Perception +10
Senses darkvision 120 ft., passive Perception 20
Languages Deep Speech, telepathy 120 ft.
Challenge 10 (5,900 XP)

Amphibious. The aboleth can breathe air and water.

Mucous Cloud. While underwater, the aboleth is surrounded by transformative mucus.
A creature that touches the aboleth or hits it with a melee attack while within 5 feet
must make a DC 14 Constitution saving throw.`;

/**
 * Sample SRD 5.2 creature content - Beholder
 */
const SRD_BEHOLDER_CONTENT = `Beholder
Large aberration, lawful evil

Armor Class 18 (natural armor)
Hit Points 180 (19d10 + 76)
Speed 0 ft., fly 20 ft. (hover)

STR 10 (+0) DEX 14 (+2) CON 18 (+4) INT 17 (+3) WIS 15 (+2) CHA 17 (+3)

Saving Throws Int +8, Wis +7, Cha +8
Skills Perception +12
Condition Immunities prone
Senses darkvision 120 ft., passive Perception 22
Languages Deep Speech, Undercommon
Challenge 13 (10,000 XP)

Antimagic Cone. The beholder's central eye creates an area of antimagic,
as in the antimagic field spell, in a 150-foot-cone.`;

// ============================================================================
// Test Data Setup
// ============================================================================

describe('Hybrid Search Chat Enhancement', () => {
  const testProjectDir = path.join(process.cwd(), '.test-hybrid-search');
  const dataDir = path.join(testProjectDir, 'data');
  const srcDir = path.join(testProjectDir, 'src');
  
  // Mock chunks that simulate real D&D chatbot data
  const testChunks = [
    {
      chunk_id: 'chunk-d50-001',
      source_id: 'wld-source',
      text: D50_ROOM_CONTENT,
      position: { index: 300, start_char: 0, end_char: D50_ROOM_CONTENT.length },
      metadata: { source_name: "World's Largest Dungeon", room: 'D50' },
      created_at: new Date().toISOString(),
    },
    {
      chunk_id: 'chunk-d55-001',
      source_id: 'wld-source',
      text: D55_ROOM_CONTENT,
      position: { index: 305, start_char: 0, end_char: D55_ROOM_CONTENT.length },
      metadata: { source_name: "World's Largest Dungeon", room: 'D55' },
      created_at: new Date().toISOString(),
    },
    {
      chunk_id: 'chunk-aboleth-001',
      source_id: 'srd-source',
      text: SRD_ABOLETH_CONTENT,
      position: { index: 10, start_char: 0, end_char: SRD_ABOLETH_CONTENT.length },
      metadata: { source_name: 'SRD 5.2', creature: 'Aboleth' },
      created_at: new Date().toISOString(),
    },
    {
      chunk_id: 'chunk-beholder-001',
      source_id: 'srd-source',
      text: SRD_BEHOLDER_CONTENT,
      position: { index: 15, start_char: 0, end_char: SRD_BEHOLDER_CONTENT.length },
      metadata: { source_name: 'SRD 5.2', creature: 'Beholder' },
      created_at: new Date().toISOString(),
    },
    // Add some filler chunks to simulate a large index
    {
      chunk_id: 'chunk-intro-001',
      source_id: 'wld-source',
      text: 'Welcome to the World\'s Largest Dungeon, a massive adventure for characters level 1-20.',
      position: { index: 0, start_char: 0, end_char: 100 },
      metadata: { source_name: "World's Largest Dungeon" },
      created_at: new Date().toISOString(),
    },
    {
      chunk_id: 'chunk-srd-intro-001',
      source_id: 'srd-source',
      text: 'System Reference Document 5.2 contains the core rules for the world\'s greatest roleplaying game.',
      position: { index: 0, start_char: 0, end_char: 100 },
      metadata: { source_name: 'SRD 5.2' },
      created_at: new Date().toISOString(),
    },
  ];
  
  // Mock embeddings (1536 dimensions, normalized)
  function createMockEmbedding(seed: number): number[] {
    const embedding: number[] = [];
    for (let i = 0; i < 1536; i++) {
      // Create deterministic but varied embeddings based on seed
      embedding.push(Math.sin(seed * (i + 1) * 0.001) * 0.1);
    }
    // Normalize
    const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0));
    return embedding.map(v => v / norm);
  }
  
  const testVectors = testChunks.map((chunk, i) => ({
    chunk_id: chunk.chunk_id,
    embedding: createMockEmbedding(i * 100),
    model: 'openai/text-embedding-3-small',
    created_at: new Date().toISOString(),
  }));

  beforeAll(async () => {
    // Setup test project directory
    await fs.mkdir(dataDir, { recursive: true });
    await fs.mkdir(srcDir, { recursive: true });
    
    // Write test chunks
    const chunksContent = testChunks.map(c => JSON.stringify(c)).join('\n');
    await fs.writeFile(path.join(dataDir, 'chunks.jsonl'), chunksContent, 'utf-8');
    
    // Write test vectors
    const vectorsContent = testVectors.map(v => JSON.stringify(v)).join('\n');
    await fs.writeFile(path.join(dataDir, 'vectors.jsonl'), vectorsContent, 'utf-8');
    
    // Write test manifest
    const manifest = {
      project_id: 'test-dnd-chatbot',
      name: 'D&D Chatbot Test',
      embedding_model: { provider: 'openai', model_name: 'text-embedding-3-small', api_key_env: 'OPENAI_API_KEY' },
      chunk_config: { strategy: 'recursive', max_chars: 1500, overlap_chars: 150 },
      stats: { sources_count: 2, chunks_count: testChunks.length, vectors_count: testVectors.length },
    };
    await fs.writeFile(path.join(testProjectDir, 'project.json'), JSON.stringify(manifest, null, 2));
    
    // Write test sources
    const sources = [
      { source_id: 'wld-source', type: 'pdf', uri: 'worlds-largest-dungeon.pdf', source_name: "World's Largest Dungeon", status: 'completed' },
      { source_id: 'srd-source', type: 'pdf', uri: 'srd-5.2.pdf', source_name: 'SRD 5.2', status: 'completed' },
    ];
    const sourcesContent = sources.map(s => JSON.stringify(s)).join('\n');
    await fs.writeFile(path.join(testProjectDir, 'sources.jsonl'), sourcesContent, 'utf-8');
  });

  afterAll(async () => {
    // Cleanup test directory
    try {
      await fs.rm(testProjectDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  // ============================================================================
  // D50 Room Retrieval Tests
  // ============================================================================

  describe('D50 Room Retrieval', () => {
    it('should retrieve D50 room content when asking about "Chamber of Binding"', async () => {
      // This test demonstrates the keyword search limitation
      // The query "What creatures are in the Chamber of Binding?" should find D50
      // but keyword search may fail if terms don't match exactly
      
      const query = 'What creatures are in the Chamber of Binding?';
      
      // Import the function that should exist but doesn't yet
      // This will cause the test to fail immediately
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const results = await searchHybridForChat({
        query,
        chunks: testChunks,
        vectors: testVectors,
        topK: 5,
      });
      
      // Expect D50 content to be in top results
      const d50Found = results.some(r => 
        r.chunk_id === 'chunk-d50-001' || 
        r.text.includes('D50') || 
        r.text.includes('Chamber of Binding')
      );
      
      expect(d50Found).toBe(true);
      expect(results[0].text).toContain('Shadow Demons');
    });

    it('should retrieve D50 room when asking semantic question about "cursed restraints"', async () => {
      // Semantic query that won't match keywords but should match meaning
      const query = 'Where can I find cursed restraints that paralyze adventurers?';
      
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const results = await searchHybridForChat({
        query,
        chunks: testChunks,
        vectors: testVectors,
        topK: 5,
      });
      
      // D50 has cursed manacles that paralyze - should be found via semantic search
      const d50Found = results.some(r => 
        r.text.includes('manacles') || 
        r.text.includes('paralyzed')
      );
      
      expect(d50Found).toBe(true);
    });

    it('should retrieve D50 room when asking about "demons lurking in darkness"', async () => {
      const query = 'Tell me about demons that lurk in darkness near ceilings';
      
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const results = await searchHybridForChat({
        query,
        chunks: testChunks,
        vectors: testVectors,
        topK: 5,
      });
      
      // D50 has Shadow Demons lurking near ceiling
      const d50Found = results.some(r => r.text.includes('Shadow Demons'));
      
      expect(d50Found).toBe(true);
    });
  });

  // ============================================================================
  // D55 Room Retrieval Tests
  // ============================================================================

  describe('D55 Room Retrieval', () => {
    it('should retrieve D55 room when asking about "flooded library"', async () => {
      const query = 'What hazards are in the flooded library?';
      
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const results = await searchHybridForChat({
        query,
        chunks: testChunks,
        vectors: testVectors,
        topK: 5,
      });
      
      const d55Found = results.some(r => 
        r.chunk_id === 'chunk-d55-001' || 
        r.text.includes('Sunken Library') ||
        r.text.includes('Water Weirds')
      );
      
      expect(d55Found).toBe(true);
    });

    it('should retrieve D55 when asking about "underwater electricity trap"', async () => {
      // Semantic query - "electricity trap" should match "lightning glyph"
      const query = 'Is there a room with an underwater electricity trap?';
      
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const results = await searchHybridForChat({
        query,
        chunks: testChunks,
        vectors: testVectors,
        topK: 5,
      });
      
      const d55Found = results.some(r => r.text.includes('lightning glyph'));
      
      expect(d55Found).toBe(true);
    });
  });

  // ============================================================================
  // SRD Creature Retrieval Tests
  // ============================================================================

  describe('SRD Creature Retrieval', () => {
    it('should retrieve Aboleth stats when asking about "telepathic aberration"', async () => {
      // Semantic query - "telepathic aberration" should match Aboleth
      const query = 'What are the stats for a telepathic aberration that transforms creatures with mucus?';
      
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const results = await searchHybridForChat({
        query,
        chunks: testChunks,
        vectors: testVectors,
        topK: 5,
      });
      
      const abolethFound = results.some(r => 
        r.text.includes('Aboleth') || 
        r.text.includes('Mucous Cloud')
      );
      
      expect(abolethFound).toBe(true);
    });

    it('should retrieve Aboleth when asking "underwater psychic monster"', async () => {
      const query = 'What is the CR of the underwater psychic monster with telepathy?';
      
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const results = await searchHybridForChat({
        query,
        chunks: testChunks,
        vectors: testVectors,
        topK: 5,
      });
      
      const abolethFound = results.some(r => 
        r.text.includes('Challenge 10') && r.text.includes('Aboleth')
      );
      
      expect(abolethFound).toBe(true);
    });

    it('should retrieve Beholder stats when asking about "floating eye tyrant"', async () => {
      const query = 'What can nullify magic in a cone shape? Stats for the floating eye tyrant?';
      
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const results = await searchHybridForChat({
        query,
        chunks: testChunks,
        vectors: testVectors,
        topK: 5,
      });
      
      const beholderFound = results.some(r => 
        r.text.includes('Beholder') || 
        r.text.includes('Antimagic Cone')
      );
      
      expect(beholderFound).toBe(true);
    });

    it('should retrieve Beholder when asking about "creature with antimagic field eye"', async () => {
      const query = 'Which creature has an eye that creates antimagic field?';
      
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const results = await searchHybridForChat({
        query,
        chunks: testChunks,
        vectors: testVectors,
        topK: 5,
      });
      
      const beholderFound = results.some(r => r.text.includes('Antimagic Cone'));
      
      expect(beholderFound).toBe(true);
    });
  });

  // ============================================================================
  // Query Embedding Generation Tests
  // ============================================================================

  describe('Query Embedding Generation', () => {
    it('should have generateQueryEmbedding function exported', async () => {
      // This function must exist for hybrid search to work
      const { generateQueryEmbedding } = await import('../src/tools/projects.js');
      
      expect(generateQueryEmbedding).toBeDefined();
      expect(typeof generateQueryEmbedding).toBe('function');
    });

    // Integration test - requires real OpenAI API key
    // Skip if OPENAI_API_KEY is not a real key (starts with 'sk-')
    const hasRealApiKey = process.env.OPENAI_API_KEY?.startsWith('sk-') ?? false;
    
    it.skipIf(!hasRealApiKey)('should generate 1536-dimensional embedding for query text', async () => {
      const { generateQueryEmbedding } = await import('../src/tools/projects.js');
      
      const query = 'What creatures are in the Chamber of Binding?';
      
      const embedding = await generateQueryEmbedding({
        text: query,
        model: { provider: 'openai', model_name: 'text-embedding-3-small', api_key_env: 'OPENAI_API_KEY' },
      });
      
      expect(embedding).toBeInstanceOf(Array);
      expect(embedding.length).toBe(1536);
    });

    it.skipIf(!hasRealApiKey)('should return normalized embedding vector', async () => {
      const { generateQueryEmbedding } = await import('../src/tools/projects.js');
      
      const query = 'Test query for normalization';
      
      const embedding = await generateQueryEmbedding({
        text: query,
        model: { provider: 'openai', model_name: 'text-embedding-3-small', api_key_env: 'OPENAI_API_KEY' },
      });
      
      // Check L2 norm is approximately 1
      const magnitude = Math.sqrt(embedding.reduce((sum: number, v: number) => sum + v * v, 0));
      expect(magnitude).toBeCloseTo(1, 1);
    });

    it('should throw error when API key is missing', async () => {
      const { generateQueryEmbedding } = await import('../src/tools/projects.js');
      
      // Remove API key
      delete process.env.OPENAI_API_KEY;
      
      await expect(generateQueryEmbedding({
        text: 'Test query',
        model: { provider: 'openai', model_name: 'text-embedding-3-small', api_key_env: 'OPENAI_API_KEY' },
      })).rejects.toThrow('API key');
    });
  });

  // ============================================================================
  // Hybrid Search Function Tests
  // ============================================================================

  describe('Hybrid Search Function', () => {
    it('should export searchHybridForChat function', async () => {
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      expect(searchHybridForChat).toBeDefined();
      expect(typeof searchHybridForChat).toBe('function');
    });

    it('should combine keyword and semantic scores using RRF', async () => {
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const results = await searchHybridForChat({
        query: 'Shadow Demons',  // Should match keyword in D50
        chunks: testChunks,
        vectors: testVectors,
        topK: 5,
      });
      
      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(5);
      
      // Results should be sorted by combined score
      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });

    it('should return results with chunk_id, text, score, and source_id', async () => {
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const results = await searchHybridForChat({
        query: 'dungeon room',
        chunks: testChunks,
        vectors: testVectors,
        topK: 3,
      });
      
      expect(results.length).toBeGreaterThan(0);
      
      const result = results[0];
      expect(result).toHaveProperty('chunk_id');
      expect(result).toHaveProperty('text');
      expect(result).toHaveProperty('score');
      expect(result).toHaveProperty('source_id');
    });

    it('should handle empty query gracefully', async () => {
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const results = await searchHybridForChat({
        query: '',
        chunks: testChunks,
        vectors: testVectors,
        topK: 5,
      });
      
      expect(results).toBeInstanceOf(Array);
    });
  });

  // ============================================================================
  // Template Generator Tests
  // ============================================================================

  describe('Template Generator Hybrid Search', () => {
    it('should generate /chat endpoint with hybrid search', async () => {
      // Import the template generator function
      const { generateMcpServerSourceForTest } = await import('../src/tools/projects.js');
      
      const source = generateMcpServerSourceForTest('test-server', 'Test description', 8080, true);
      
      // The generated code should use hybrid search, not just keyword
      expect(source).toContain('searchHybrid');
      expect(source).not.toMatch(/searchKeyword\(question,\s*Math\.min\(top_k/);
    });

    it('should generate code that embeds user questions', async () => {
      const { generateMcpServerSourceForTest } = await import('../src/tools/projects.js');
      
      const source = generateMcpServerSourceForTest('test-server', 'Test description', 8080, true);
      
      // The generated /chat endpoint should embed the question
      expect(source).toContain('generateQueryEmbedding');
      expect(source).toContain('query_vector');
    });

    it('should generate code with hybrid search mode in /chat', async () => {
      const { generateMcpServerSourceForTest } = await import('../src/tools/projects.js');
      
      const source = generateMcpServerSourceForTest('test-server', 'Test description', 8080, true);
      
      // Should have mode: "hybrid" or equivalent logic
      expect(source).toMatch(/mode.*hybrid|searchHybrid|hybrid.*search/i);
    });
  });

  // ============================================================================
  // Integration Tests - Full Chat Flow
  // ============================================================================

  describe('Chat Endpoint Integration', () => {
    it('should use hybrid search in the chat endpoint flow', async () => {
      // This tests the full flow: question -> embedding -> hybrid search -> context
      const { chatWithHybridSearch } = await import('../src/tools/projects.js');
      
      // Set API key to enable hybrid mode (key validity doesn't matter for this test)
      const originalKey = process.env.OPENAI_API_KEY;
      process.env.OPENAI_API_KEY = 'test-key';
      
      try {
        const result = await chatWithHybridSearch({
          question: 'What creatures lurk in the Chamber of Binding?',
          projectDir: testProjectDir,
          topK: 5,
        });
        
        // The context should include D50 room content
        expect(result.context).toContain('D50');
        expect(result.context).toContain('Shadow Demons');
        expect(result.searchMode).toBe('hybrid');
      } finally {
        // Restore original key
        if (originalKey) {
          process.env.OPENAI_API_KEY = originalKey;
        } else {
          delete process.env.OPENAI_API_KEY;
        }
      }
    });

    it('should retrieve SRD content via chat hybrid search', async () => {
      const { chatWithHybridSearch } = await import('../src/tools/projects.js');
      
      const result = await chatWithHybridSearch({
        question: 'What is the AC of an Aboleth?',
        projectDir: testProjectDir,
        topK: 5,
      });
      
      expect(result.context).toContain('Aboleth');
      expect(result.context).toContain('17');  // AC value
      expect(result.sources).toContainEqual(expect.objectContaining({
        source_name: 'SRD 5.2'
      }));
    });

    it('should fall back to keyword search when embedding fails', async () => {
      const { chatWithHybridSearch } = await import('../src/tools/projects.js');
      
      // Remove API key to force fallback
      const originalKey = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      
      try {
        const result = await chatWithHybridSearch({
          question: 'Shadow Demons',  // Exact keyword match should still work
          projectDir: testProjectDir,
          topK: 5,
        });
        
        expect(result.searchMode).toBe('keyword');  // Fell back to keyword
        expect(result.context).toContain('Shadow Demons');
      } finally {
        if (originalKey) process.env.OPENAI_API_KEY = originalKey;
      }
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle queries with special D&D notation (D50, CR 4)', async () => {
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const results = await searchHybridForChat({
        query: 'What is in room D50?',
        chunks: testChunks,
        vectors: testVectors,
        topK: 5,
      });
      
      const d50Found = results.some(r => r.text.includes('D50'));
      expect(d50Found).toBe(true);
    });

    it('should handle queries with game mechanics terms (DC, saving throw)', async () => {
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const results = await searchHybridForChat({
        query: 'What is the DC for the wisdom saving throw in the binding chamber?',
        chunks: testChunks,
        vectors: testVectors,
        topK: 5,
      });
      
      // Should find D50 which has DC 16 Wisdom save
      const found = results.some(r => r.text.includes('DC 16') || r.text.includes('Wisdom save'));
      expect(found).toBe(true);
    });

    it('should handle very long queries', async () => {
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const longQuery = 'I am looking for a room in the dungeon that has some kind of creatures, ' +
        'possibly demons or fiends, that attack from above, maybe from the ceiling or darkness, ' +
        'and there might be some kind of trap or curse involved with restraints or bindings ' +
        'that could paralyze or immobilize adventurers who are not careful.';
      
      const results = await searchHybridForChat({
        query: longQuery,
        chunks: testChunks,
        vectors: testVectors,
        topK: 5,
      });
      
      // Should find D50 based on semantic similarity
      expect(results.length).toBeGreaterThan(0);
    });

    it('should handle queries in different phrasings for same content', async () => {
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const queries = [
        'Shadow Demons in D50',
        'Where are the shadow demons?',
        'demons lurking near ceiling',
        'fiends that attack from above',
      ];
      
      for (const query of queries) {
        const results = await searchHybridForChat({
          query,
          chunks: testChunks,
          vectors: testVectors,
          topK: 5,
        });
        
        // All variations should find D50 content
        const d50Found = results.some(r => r.text.includes('Shadow Demons'));
        expect(d50Found).toBe(true);
      }
    });
  });

  // ============================================================================
  // Performance Considerations
  // ============================================================================

  describe('Performance', () => {
    it('should complete hybrid search within 100ms for small datasets', async () => {
      const { searchHybridForChat } = await import('../src/tools/projects.js');
      
      const startTime = Date.now();
      
      await searchHybridForChat({
        query: 'Chamber of Binding demons',
        chunks: testChunks,
        vectors: testVectors,
        topK: 5,
      });
      
      const duration = Date.now() - startTime;
      expect(duration).toBeLessThan(100);
    });

    it('should use RRF constant k=60 for score fusion', async () => {
      // RRF formula: score = sum(1 / (k + rank))
      // k=60 is standard for balancing keyword and semantic
      const { searchHybridForChat, RRF_CONSTANT } = await import('../src/tools/projects.js');
      
      expect(RRF_CONSTANT).toBe(60);
    });
  });
});
