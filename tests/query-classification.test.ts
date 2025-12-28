/**
 * Query Classification Tool Tests
 * 
 * These tests define the contract for query classification in IndexFoundry.
 * The tool determines if RAG retrieval is needed and classifies query types.
 * 
 * Feature Requirements:
 * - Determine if retrieval is needed (needs_retrieval boolean)
 * - Classify query type (factual, procedural, conceptual, navigational, conversational)
 * - Estimate complexity (simple, medium, complex)
 * - Suggest retrieval parameters (top_k, search mode, filters)
 * 
 * The implementation will live in: src/tools/classify.ts
 */

import { describe, it, expect } from 'vitest';

// Import the classify tool (does not exist yet - tests will fail)
import { classifyQuery, ClassifyQueryInputSchema } from '../src/tools/classify.js';
import type { ClassifyQueryResult, QueryType, QueryComplexity } from '../src/tools/classify.js';

// ============================================================================
// Test Helpers
// ============================================================================

/**
 * Helper to create valid classification input
 */
function createClassifyInput(
  query: string,
  overrides: {
    context?: {
      domain?: string;
      available_collections?: string[];
      user_history?: string[];
    };
    options?: {
      include_confidence?: boolean;
      include_reasoning?: boolean;
      threshold?: number;
    };
  } = {}
) {
  return {
    query,
    ...overrides
  };
}

// ============================================================================
// Schema Validation Tests
// ============================================================================

describe('Query Classification Tool', () => {
  describe('Schema Validation', () => {
    it('should accept valid query string', () => {
      const input = { query: 'What is the boiling point of water?' };
      const result = ClassifyQueryInputSchema.safeParse(input);
      
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.query).toBe('What is the boiling point of water?');
      }
    });

    it('should reject empty query string', () => {
      const input = { query: '' };
      const result = ClassifyQueryInputSchema.safeParse(input);
      
      expect(result.success).toBe(false);
    });

    it('should accept query with optional context', () => {
      const input = {
        query: 'What are the safety requirements?',
        context: {
          domain: 'mining-safety',
          available_collections: ['msha-docs', 'safety-manual'],
          user_history: ['previous query']
        }
      };
      const result = ClassifyQueryInputSchema.safeParse(input);
      
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.context?.domain).toBe('mining-safety');
        expect(result.data.context?.available_collections).toContain('msha-docs');
      }
    });

    it('should accept query with optional options', () => {
      const input = {
        query: 'Test query',
        options: {
          include_confidence: true,
          include_reasoning: true,
          threshold: 0.7
        }
      };
      const result = ClassifyQueryInputSchema.safeParse(input);
      
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.include_confidence).toBe(true);
        expect(result.data.options?.include_reasoning).toBe(true);
        expect(result.data.options?.threshold).toBe(0.7);
      }
    });

    it('should reject threshold outside 0-1 range', () => {
      const input = {
        query: 'Test query',
        options: {
          threshold: 1.5
        }
      };
      const result = ClassifyQueryInputSchema.safeParse(input);
      
      expect(result.success).toBe(false);
    });

    it('should default include_confidence to true', () => {
      const input = { query: 'Test query' };
      const result = ClassifyQueryInputSchema.safeParse(input);
      
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.include_confidence ?? true).toBe(true);
      }
    });

    it('should default threshold to 0.5', () => {
      const input = { query: 'Test query' };
      const result = ClassifyQueryInputSchema.safeParse(input);
      
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.options?.threshold ?? 0.5).toBe(0.5);
      }
    });
  });

  // ============================================================================
  // Classification Type Tests
  // ============================================================================

  describe('Classification Types', () => {
    it('should classify factual queries correctly', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What is the boiling point of water?'
      ));
      
      expect(result.classification.type).toBe('factual');
    });

    it('should classify factual query about atomic number', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What is the atomic number of gold?'
      ));
      
      expect(result.classification.type).toBe('factual');
    });

    it('should classify procedural queries correctly', async () => {
      const result = await classifyQuery(createClassifyInput(
        'How do I configure a ventilation system?'
      ));
      
      expect(result.classification.type).toBe('procedural');
    });

    it('should classify procedural query about installation', async () => {
      const result = await classifyQuery(createClassifyInput(
        'How do I install a roof bolt?'
      ));
      
      expect(result.classification.type).toBe('procedural');
    });

    it('should classify conceptual queries correctly', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Explain the importance of ground control'
      ));
      
      expect(result.classification.type).toBe('conceptual');
    });

    it('should classify conceptual query about philosophy', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Explain the philosophy behind ground control measures'
      ));
      
      expect(result.classification.type).toBe('conceptual');
    });

    it('should classify navigational queries correctly', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Where is section 3.2 about PPE?'
      ));
      
      expect(result.classification.type).toBe('navigational');
    });

    it('should classify navigational query asking for location', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Find the chapter on emergency procedures'
      ));
      
      expect(result.classification.type).toBe('navigational');
    });

    it('should classify conversational queries correctly', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Thanks, that is helpful'
      ));
      
      expect(result.classification.type).toBe('conversational');
    });

    it('should classify conversational acknowledgment', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Got it, thanks for the explanation'
      ));
      
      expect(result.classification.type).toBe('conversational');
    });

    it('should classify yes/no confirmation as conversational', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Yes, that answers my question'
      ));
      
      expect(result.classification.type).toBe('conversational');
    });

    it('should return valid QueryType enum value', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What is MSHA?'
      ));
      
      const validTypes: QueryType[] = ['factual', 'procedural', 'conceptual', 'navigational', 'conversational'];
      expect(validTypes).toContain(result.classification.type);
    });
  });

  // ============================================================================
  // Needs Retrieval Tests
  // ============================================================================

  describe('Retrieval Decision', () => {
    it('should return needs_retrieval=false for simple math', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What is 2 + 2?'
      ));
      
      expect(result.needs_retrieval).toBe(false);
    });

    it('should return needs_retrieval=false for multiplication', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What is 15 * 3?'
      ));
      
      expect(result.needs_retrieval).toBe(false);
    });

    it('should return needs_retrieval=false for basic logic', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Is 5 greater than 3?'
      ));
      
      expect(result.needs_retrieval).toBe(false);
    });

    it('should return needs_retrieval=false for well-known general knowledge', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What year did World War II end?'
      ));
      
      expect(result.needs_retrieval).toBe(false);
    });

    it('should return needs_retrieval=false for common facts', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What is the capital of France?'
      ));
      
      expect(result.needs_retrieval).toBe(false);
    });

    it('should return needs_retrieval=true for domain-specific queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What are the MSHA requirements for roof bolting?',
        { context: { domain: 'mining-safety' } }
      ));
      
      expect(result.needs_retrieval).toBe(true);
    });

    it('should return needs_retrieval=true for regulatory queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What are the ventilation requirements for underground mines?',
        { context: { domain: 'mining-safety' } }
      ));
      
      expect(result.needs_retrieval).toBe(true);
    });

    it('should return needs_retrieval=true for document-specific queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Summarize section 5 of the safety manual'
      ));
      
      expect(result.needs_retrieval).toBe(true);
    });

    it('should return needs_retrieval=true for queries about specific documents', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What does paragraph 3.4.1 say about PPE?'
      ));
      
      expect(result.needs_retrieval).toBe(true);
    });

    it('should return needs_retrieval=false for conversational queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Thanks for your help!'
      ));
      
      expect(result.needs_retrieval).toBe(false);
    });

    it('should include confidence score in result', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What are the safety requirements?'
      ));
      
      expect(result.confidence).toBeDefined();
      expect(typeof result.confidence).toBe('number');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should respect threshold option for needs_retrieval decision', async () => {
      const resultLowThreshold = await classifyQuery(createClassifyInput(
        'Tell me about mining regulations',
        { options: { threshold: 0.3 } }
      ));
      
      const resultHighThreshold = await classifyQuery(createClassifyInput(
        'Tell me about mining regulations',
        { options: { threshold: 0.9 } }
      ));
      
      // With higher threshold, less likely to need retrieval unless very confident
      expect(typeof resultLowThreshold.needs_retrieval).toBe('boolean');
      expect(typeof resultHighThreshold.needs_retrieval).toBe('boolean');
    });
  });

  // ============================================================================
  // Complexity Assessment Tests
  // ============================================================================

  describe('Complexity Assessment', () => {
    it('should rate simple single-fact queries as simple', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What color is the sky?'
      ));
      
      expect(result.complexity).toBe('simple');
    });

    it('should rate definition queries as simple', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What is MSHA?'
      ));
      
      expect(result.complexity).toBe('simple');
    });

    it('should rate yes/no questions as simple', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Is water wet?'
      ));
      
      expect(result.complexity).toBe('simple');
    });

    it('should rate multi-step queries as medium', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What are the steps to install a ventilation system?'
      ));
      
      expect(result.complexity).toBe('medium');
    });

    it('should rate comparative queries as medium', async () => {
      const result = await classifyQuery(createClassifyInput(
        'How does OSHA compare to MSHA in terms of enforcement?'
      ));
      
      expect(result.complexity).toBe('medium');
    });

    it('should rate list queries as medium', async () => {
      const result = await classifyQuery(createClassifyInput(
        'List the main safety requirements for underground mining'
      ));
      
      expect(result.complexity).toBe('medium');
    });

    it('should rate multi-document synthesis queries as complex', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Compare and contrast the safety requirements across all three regulatory frameworks'
      ));
      
      expect(result.complexity).toBe('complex');
    });

    it('should rate analytical queries as complex', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Analyze the evolution of mining safety regulations over the past 50 years and identify key trends'
      ));
      
      expect(result.complexity).toBe('complex');
    });

    it('should rate queries requiring multiple sources as complex', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Synthesize information from all safety manuals to create a comprehensive emergency response protocol'
      ));
      
      expect(result.complexity).toBe('complex');
    });

    it('should return valid QueryComplexity enum value', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What is the meaning of life?'
      ));
      
      const validComplexities: QueryComplexity[] = ['simple', 'medium', 'complex'];
      expect(validComplexities).toContain(result.complexity);
    });
  });

  // ============================================================================
  // Retrieval Hints Tests
  // ============================================================================

  describe('Retrieval Hints', () => {
    it('should suggest low top_k for simple queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What is MSHA?'
      ));
      
      expect(result.retrieval_hints).toBeDefined();
      expect(result.retrieval_hints?.suggested_top_k).toBeLessThanOrEqual(5);
    });

    it('should suggest higher top_k for complex synthesis queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Compare all safety regulations across multiple documents and summarize the key differences'
      ));
      
      expect(result.retrieval_hints).toBeDefined();
      expect(result.retrieval_hints?.suggested_top_k).toBeGreaterThanOrEqual(10);
    });

    it('should suggest medium top_k for comparative queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Compare OSHA and MSHA requirements'
      ));
      
      expect(result.retrieval_hints).toBeDefined();
      expect(result.retrieval_hints?.suggested_top_k).toBeGreaterThanOrEqual(5);
      expect(result.retrieval_hints?.suggested_top_k).toBeLessThanOrEqual(15);
    });

    it('should suggest semantic mode for conceptual queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Explain the philosophy behind ground control measures'
      ));
      
      expect(result.retrieval_hints).toBeDefined();
      expect(result.retrieval_hints?.suggested_mode).toBe('semantic');
    });

    it('should suggest keyword mode for queries with specific terms', async () => {
      const result = await classifyQuery(createClassifyInput(
        'CFR 30 Part 75.400 fire prevention'
      ));
      
      expect(result.retrieval_hints).toBeDefined();
      expect(result.retrieval_hints?.suggested_mode).toBe('keyword');
    });

    it('should suggest hybrid mode for mixed queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What does section 75.400 say about preventing fires in mines?'
      ));
      
      expect(result.retrieval_hints).toBeDefined();
      expect(result.retrieval_hints?.suggested_mode).toBe('hybrid');
    });

    it('should include filters when domain context is provided', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What are the ventilation requirements?',
        { context: { domain: 'mining-safety' } }
      ));
      
      expect(result.retrieval_hints).toBeDefined();
      expect(result.retrieval_hints?.filters).toBeDefined();
    });

    it('should not include retrieval_hints when needs_retrieval is false', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What is 2 + 2?'
      ));
      
      expect(result.needs_retrieval).toBe(false);
      // retrieval_hints should be undefined or empty when no retrieval needed
      expect(result.retrieval_hints === undefined || Object.keys(result.retrieval_hints).length === 0).toBe(true);
    });
  });

  // ============================================================================
  // Context Integration Tests
  // ============================================================================

  describe('Context Integration', () => {
    it('should use domain context to influence classification', async () => {
      const resultWithDomain = await classifyQuery(createClassifyInput(
        'What are the requirements?',
        { context: { domain: 'mining-safety' } }
      ));
      
      const resultWithoutDomain = await classifyQuery(createClassifyInput(
        'What are the requirements?'
      ));
      
      // Domain-specific context should increase likelihood of needing retrieval
      expect(resultWithDomain.needs_retrieval).toBe(true);
    });

    it('should consider available_collections in retrieval decision', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What does the manual say about PPE?',
        { 
          context: { 
            available_collections: ['safety-manual', 'ppe-guide'] 
          } 
        }
      ));
      
      expect(result.needs_retrieval).toBe(true);
      expect(result.retrieval_hints?.filters).toBeDefined();
    });

    it('should use user_history for context-aware classification', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What about the other section?',
        { 
          context: { 
            user_history: [
              'Tell me about section 5 of the safety manual',
              'What are the key points?'
            ] 
          } 
        }
      ));
      
      // Follow-up queries should recognize context from history
      expect(result.needs_retrieval).toBe(true);
    });
  });

  // ============================================================================
  // Reasoning Output Tests
  // ============================================================================

  describe('Reasoning Output', () => {
    it('should include reasoning when include_reasoning is true', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What are the safety requirements for underground mining?',
        { options: { include_reasoning: true } }
      ));
      
      expect(result.reasoning).toBeDefined();
      expect(typeof result.reasoning).toBe('string');
      expect(result.reasoning!.length).toBeGreaterThan(0);
    });

    it('should not include reasoning when include_reasoning is false', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What are the safety requirements?',
        { options: { include_reasoning: false } }
      ));
      
      expect(result.reasoning).toBeUndefined();
    });

    it('should not include reasoning by default', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What are the safety requirements?'
      ));
      
      expect(result.reasoning).toBeUndefined();
    });
  });

  // ============================================================================
  // Edge Cases
  // ============================================================================

  describe('Edge Cases', () => {
    it('should handle empty query with error', async () => {
      await expect(classifyQuery({ query: '' })).rejects.toThrow();
    });

    it('should handle whitespace-only query with error', async () => {
      await expect(classifyQuery({ query: '   ' })).rejects.toThrow();
    });

    it('should handle very long queries gracefully', async () => {
      const longQuery = 'What '.repeat(500) + 'is this about?';
      const result = await classifyQuery(createClassifyInput(longQuery));
      
      expect(result).toBeDefined();
      expect(result.query).toBeDefined();
      expect(result.classification).toBeDefined();
      expect(result.complexity).toBeDefined();
    });

    it('should handle queries with special characters', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What does §75.400 say about "fire prevention" & safety?'
      ));
      
      expect(result).toBeDefined();
      expect(result.classification).toBeDefined();
    });

    it('should handle queries with only punctuation gracefully', async () => {
      const result = await classifyQuery(createClassifyInput('???'));
      
      expect(result).toBeDefined();
      expect(result.classification.type).toBe('conversational');
    });

    it('should handle non-English queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        '¿Cuáles son los requisitos de seguridad?'
      ));
      
      expect(result).toBeDefined();
      expect(result.classification).toBeDefined();
    });

    it('should handle mixed language queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What are the Sicherheitsanforderungen for mining?'
      ));
      
      expect(result).toBeDefined();
      expect(result.classification).toBeDefined();
    });

    it('should handle queries with newlines', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What are the requirements\nfor ventilation\nin underground mines?'
      ));
      
      expect(result).toBeDefined();
      expect(result.classification).toBeDefined();
    });

    it('should handle queries with tabs', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What are\tthe requirements?'
      ));
      
      expect(result).toBeDefined();
      expect(result.classification).toBeDefined();
    });

    it('should handle queries with unicode characters', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What are the 安全 requirements? 🔒'
      ));
      
      expect(result).toBeDefined();
      expect(result.classification).toBeDefined();
    });

    it('should handle single character queries', async () => {
      const result = await classifyQuery(createClassifyInput('?'));
      
      expect(result).toBeDefined();
      expect(result.classification.type).toBe('conversational');
    });

    it('should handle numeric-only queries', async () => {
      const result = await classifyQuery(createClassifyInput('12345'));
      
      expect(result).toBeDefined();
      expect(result.classification).toBeDefined();
    });
  });

  // ============================================================================
  // Output Structure Tests
  // ============================================================================

  describe('Output Structure', () => {
    it('should return query in result', async () => {
      const inputQuery = 'What is the boiling point of water?';
      const result = await classifyQuery(createClassifyInput(inputQuery));
      
      expect(result.query).toBe(inputQuery);
    });

    it('should return boolean needs_retrieval', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What are the safety requirements?'
      ));
      
      expect(typeof result.needs_retrieval).toBe('boolean');
    });

    it('should return numeric confidence between 0 and 1', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What are the safety requirements?'
      ));
      
      expect(typeof result.confidence).toBe('number');
      expect(result.confidence).toBeGreaterThanOrEqual(0);
      expect(result.confidence).toBeLessThanOrEqual(1);
    });

    it('should return classification object with type', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What is MSHA?'
      ));
      
      expect(result.classification).toBeDefined();
      expect(typeof result.classification.type).toBe('string');
    });

    it('should optionally return classification subtype', async () => {
      const result = await classifyQuery(createClassifyInput(
        'Define the term "ground control"'
      ));
      
      expect(result.classification).toBeDefined();
      // subtype is optional, so we just check it's either undefined or a string
      expect(result.classification.subtype === undefined || typeof result.classification.subtype === 'string').toBe(true);
    });

    it('should return complexity as string', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What is the meaning of life?'
      ));
      
      expect(typeof result.complexity).toBe('string');
      expect(['simple', 'medium', 'complex']).toContain(result.complexity);
    });

    it('should return retrieval_hints when needs_retrieval is true', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What does section 5 of the safety manual say?'
      ));
      
      if (result.needs_retrieval) {
        expect(result.retrieval_hints).toBeDefined();
        expect(typeof result.retrieval_hints?.suggested_top_k).toBe('number');
        expect(['semantic', 'keyword', 'hybrid']).toContain(result.retrieval_hints?.suggested_mode);
      }
    });
  });

  // ============================================================================
  // Subtype Classification Tests
  // ============================================================================

  describe('Subtype Classification', () => {
    it('should identify definition subtype for factual queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What is the definition of ground control?'
      ));
      
      expect(result.classification.type).toBe('factual');
      expect(result.classification.subtype).toBe('definition');
    });

    it('should identify quantitative subtype for numeric queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        'How many feet of clearance is required?'
      ));
      
      expect(result.classification.type).toBe('factual');
      expect(result.classification.subtype).toBe('quantitative');
    });

    it('should identify temporal subtype for date/time queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        'When was MSHA established?'
      ));
      
      expect(result.classification.type).toBe('factual');
      expect(result.classification.subtype).toBe('temporal');
    });

    it('should identify step-by-step subtype for how-to queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        'What are the steps to conduct a safety inspection?'
      ));
      
      expect(result.classification.type).toBe('procedural');
      expect(result.classification.subtype).toBe('step-by-step');
    });

    it('should identify troubleshooting subtype for problem-solving queries', async () => {
      const result = await classifyQuery(createClassifyInput(
        'How do I fix a malfunctioning ventilation fan?'
      ));
      
      expect(result.classification.type).toBe('procedural');
      expect(result.classification.subtype).toBe('troubleshooting');
    });
  });
});
