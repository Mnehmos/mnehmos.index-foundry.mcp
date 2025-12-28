/**
 * 🔍 Query Classification Tool - IndexFoundry-MCP
 *
 * Classifies queries to determine if RAG retrieval is needed and categorizes query types.
 * Uses heuristics-based pattern matching for local classification (no LLM calls).
 *
 * Features:
 * - Query type detection (factual, procedural, conceptual, navigational, conversational)
 * - Complexity assessment (simple, medium, complex)
 * - Retrieval decision with confidence scoring
 * - Retrieval hints (top_k, search mode, filters)
 *
 * @module tools/classify
 * @see tests/query-classification.test.ts for the test contract
 *
 * Copyright (c) 2024 vario.automation
 * Proprietary and confidential. All rights reserved.
 */

import { z } from 'zod';
import { createToolError } from '../utils.js';

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Classification of query intent type
 * - factual: Questions seeking specific facts or data
 * - procedural: How-to questions seeking step-by-step guidance
 * - conceptual: Questions seeking understanding or explanation
 * - navigational: Questions seeking to locate information
 * - conversational: Social interactions, greetings, acknowledgments
 */
export type QueryType = 'factual' | 'procedural' | 'conceptual' | 'navigational' | 'conversational';

/**
 * Assessment of query complexity for determining retrieval depth
 * - simple: Single-fact lookups, direct questions
 * - medium: Comparisons, multi-step queries
 * - complex: Synthesis across multiple sources, analysis
 */
export type QueryComplexity = 'simple' | 'medium' | 'complex';

/**
 * Recommended search strategy for retrieval
 * - semantic: Vector similarity search for conceptual queries
 * - keyword: Exact term matching for codes/references
 * - hybrid: Combined semantic + keyword for best coverage
 */
export type SearchMode = 'semantic' | 'keyword' | 'hybrid';

/**
 * Complete classification result for a query
 */
export interface ClassifyQueryResult {
  /** The original query text */
  query: string;
  /** Whether RAG retrieval is recommended */
  needs_retrieval: boolean;
  /** Confidence score (0-1) for the classification */
  confidence: number;
  /** Query classification details */
  classification: {
    /** Primary query type */
    type: QueryType;
    /** Optional subtype for more specific categorization */
    subtype?: string;
  };
  /** Complexity assessment */
  complexity: QueryComplexity;
  /** Retrieval configuration hints (only if needs_retrieval is true) */
  retrieval_hints?: {
    /** Recommended number of chunks to retrieve */
    suggested_top_k: number;
    /** Recommended search strategy */
    suggested_mode: SearchMode;
    /** Optional metadata filters based on context */
    filters?: Record<string, string>;
  };
  /** Human-readable explanation (if include_reasoning is true) */
  reasoning?: string;
}

// ============================================================================
// Input Schema
// ============================================================================

/**
 * Zod schema for query classification input
 * Validates and types all input parameters
 */
export const ClassifyQueryInputSchema = z.object({
  query: z.string().min(1, 'Query cannot be empty')
    .describe("🔍 The user query to classify for retrieval decision"),
  context: z.object({
    domain: z.string().optional()
      .describe("📚 Knowledge domain (e.g., 'mining-safety', 'medical')"),
    available_collections: z.array(z.string()).optional()
      .describe("📁 Available vector collections for this context"),
    user_history: z.array(z.string()).optional()
      .describe("💬 Recent user queries for follow-up detection"),
  }).optional()
    .describe("🎯 Optional context about the knowledge domain and available resources"),
  options: z.object({
    include_confidence: z.boolean().default(true)
      .describe("📊 Include confidence score in result"),
    include_reasoning: z.boolean().default(false)
      .describe("📝 Include human-readable reasoning explanation"),
    threshold: z.number().min(0).max(1).default(0.5)
      .describe("⚖️ Confidence threshold for retrieval decision (0-1)"),
  }).optional()
    .describe("⚙️ Classification options and thresholds"),
});

export type ClassifyQueryInput = z.infer<typeof ClassifyQueryInputSchema>;

// ============================================================================
// Pattern Definitions - Organized by Category
// ============================================================================

/**
 * Pattern sets for query type detection.
 * Each category contains RegExp patterns that indicate query intent.
 */
export const QUERY_TYPE_PATTERNS = {
  /** Patterns indicating factual queries (facts, definitions, measurements) */
  factual: [
    /^what (is|are|was|were)\b/i,
    /^who (is|are|was|were)\b/i,
    /^when (did|was|is|were)\b/i,
    /^how (much|many|long|far|old)\b/i,
    /\bdefin(e|ition)\b/i,
    /\bwhat is the (definition|meaning|atomic number|boiling point|capital|color)\b/i,
    /^how many\b/i,
  ],
  
  /** Patterns indicating procedural queries (how-to, steps, instructions) */
  procedural: [
    /^how (to|do|can|should|would)\b/i,
    /\bsteps to\b/i,
    /\bguide (to|for)\b/i,
    /\binstructions? for\b/i,
    /\bprocedure for\b/i,
    /^what are the steps\b/i,
    /\bhow do i (install|configure|fix|set up|create)\b/i,
  ],
  
  /** Patterns indicating conceptual queries (explanations, understanding) */
  conceptual: [
    /^explain\b/i,
    /^describe\b/i,
    /^elaborate\b/i,
    /^why (does|do|is|are|did|was|were)\b/i,
    /\bwhat causes\b/i,
    /\bimportance of\b/i,
    /\bunderstand\b/i,
    /\bconcept of\b/i,
    /\bphilosophy\b/i,
  ],
  
  /** Patterns indicating navigational queries (finding, locating) */
  navigational: [
    /^where\b/i,
    /^find\b/i,
    /^show\b/i,
    /^locate\b/i,
    /\bsection\s+\d/i,
    /\bpage\s+\d/i,
    /\bchapter\b/i,
    /\btake me to\b/i,
    /\bgo to\b/i,
  ],
  
  /** Patterns indicating conversational queries (greetings, acknowledgments) */
  conversational: [
    /^(thanks|thank you|thx)\b/i,
    /^(ok|okay|alright)\b/i,
    /^(hello|hi|hey)\b/i,
    /^(bye|goodbye)\b/i,
    /^(yes|no|sure|yep|nope|yeah|nah)(\b|$)/i,
    /\bthat('?s| is) (helpful|great|good|clear|enough|perfect)\b/i,
    /\bgot it\b/i,
    /\banswers my question\b/i,
    /^[\?\!\.\,\;\:\-\_\@\#\$\%\^\&\*\(\)\[\]\{\}\<\>\~\`\+\=\\\/\|]+$/,
  ],
} as const;

/**
 * Patterns for queries that bypass retrieval (can be answered directly)
 */
export const RETRIEVAL_BYPASS_PATTERNS = {
  /** Mathematical/logical expressions */
  math: [
    /^\s*\d+\s*[\+\-\*\/\%]\s*\d+/,
    /^what is\s+\d+\s*[\+\-\*\/\%]\s*\d+/i,
    /^(is\s+)?\d+\s*(>|<|>=|<=|==|=|greater than|less than)\s*\d+/i,
  ],
  
  /** General knowledge (LLM can answer without retrieval) */
  generalKnowledge: [
    /\bworld war\s*(i|ii|1|2|one|two)\b/i,
    /\bcapital of\s+[a-z]+\b/i,
    /\bboiling point\b/i,
    /\batomic number\b/i,
    /\bcolor (of|is) the sky\b/i,
    /\bwhat year did\b.*\bend\b/i,
  ],
} as const;

/**
 * Patterns for queries that require retrieval
 */
export const RETRIEVAL_REQUIRED_PATTERNS = {
  /** Document-specific references */
  document: [
    /\bsection\s+\d+/i,
    /\bparagraph\s+\d+/i,
    /\bchapter\s+\d+/i,
    /\bpage\s+\d+/i,
    /\baccording to\b/i,
    /\bthe manual\b/i,
    /\bsafety manual\b/i,
    /\bsummarize\b.*\bsection\b/i,
    /\bwhat does\b.*\bsay\b/i,
  ],
  
  /** Technical codes/references (prefer keyword search) */
  keyword: [
    /\bCFR\s+\d+\b/i,
    /\bpart\s+\d+\.\d+\b/i,
    /\b\d+\.\d+\.\d+\b/,
    /^[A-Z0-9\s\.\-]+$/,
  ],
} as const;

/**
 * Patterns for complexity assessment
 */
export const COMPLEXITY_PATTERNS = {
  /** Complex queries requiring synthesis across sources */
  complex: [
    /\bcompare\b.*\bcontrast\b/i,
    /\bsynthesize\b/i,
    /\banalyze\b.*\bevolution\b/i,
    /\ball\s+(three|four|five|\d+)\b/i,
    /\bcomprehensive\b/i,
    /\bacross\b.*\b(all|multiple|several)\b/i,
    /\bidentify\b.*\btrends\b/i,
    /\bcompare\b.*\ball\b/i,
    /\bmultiple\s+documents\b/i,
    /\bthree\b.*\bframeworks\b/i,
  ],
  
  /** Medium complexity queries */
  medium: [
    /\bcompare\b/i,
    /\bcontrast\b/i,
    /\blist\b.*\bmain\b/i,
    /\bsteps\b/i,
    /\bwhat are the steps\b/i,
    /\bhow does\b.*\bcompare\b/i,
  ],
} as const;

/**
 * Patterns for subtype detection
 */
export const SUBTYPE_PATTERNS = {
  /** Definition subtypes */
  definition: [
    /\bdefin(e|ition)\b/i,
    /\bwhat is\b/i,
    /\bmeaning of\b/i,
  ],
  
  /** Quantitative subtypes */
  quantitative: [
    /\bhow (many|much)\b/i,
    /\bhow.*\bfeet\b/i,
    /\bnumber of\b/i,
    /\bclearance\b.*\brequired\b/i,
  ],
  
  /** Temporal subtypes */
  temporal: [
    /\bwhen\b/i,
    /\bwhat year\b/i,
    /\bwhat date\b/i,
    /\bestablished\b/i,
  ],
  
  /** Step-by-step subtypes */
  stepByStep: [
    /\bsteps to\b/i,
    /\bwhat are the steps\b/i,
    /\bhow to\b/i,
  ],
  
  /** Troubleshooting subtypes */
  troubleshooting: [
    /\bfix\b/i,
    /\bmalfunctioning\b/i,
    /\btroubleshoot\b/i,
    /\bnot working\b/i,
    /\bproblem\b/i,
  ],
} as const;

/**
 * Common acronyms that don't indicate domain-specific content
 */
const COMMON_ACRONYMS = /\b(OK|USA|UK|EU|UN|TV|PC|AI|CEO|HR|IT|VIP|FAQ|DIY|ATM|PIN|GPS|URL|PDF|HTML|CSS|USB|DVD|CD|AM|PM|BC|AD|IQ|ER|OR|ID|VS|ETA|ASAP|FYI|BTW|LOL|OMG|TBD|TBA|NA|RIP|MIA|POV|ETC)\b/i;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Check if text matches any pattern in a pattern array.
 *
 * @param text - Text to match against patterns
 * @param patterns - Array of RegExp patterns to test
 * @returns true if any pattern matches
 *
 * @example
 * matchesPatterns("what is the capital", QUERY_TYPE_PATTERNS.factual)
 * // returns true
 */
function matchesPatterns(text: string, patterns: readonly RegExp[]): boolean {
  return patterns.some(pattern => pattern.test(text));
}

/**
 * Count how many patterns match the given text.
 *
 * @param text - Text to match against patterns
 * @param patterns - Array of RegExp patterns to test
 * @returns Number of matching patterns
 */
function countPatternMatches(text: string, patterns: readonly RegExp[]): number {
  return patterns.filter(pattern => pattern.test(text)).length;
}

/**
 * Detect the primary query type from normalized query text.
 *
 * @param normalizedQuery - Lowercase, trimmed query text
 * @param originalQuery - Original query for length/character checks
 * @returns Detected QueryType
 */
function detectQueryType(normalizedQuery: string, originalQuery: string): QueryType {
  // Check conversational first (highest priority for non-question content)
  if (matchesPatterns(normalizedQuery, QUERY_TYPE_PATTERNS.conversational)) {
    return 'conversational';
  }
  
  // Check navigational
  if (matchesPatterns(normalizedQuery, QUERY_TYPE_PATTERNS.navigational)) {
    return 'navigational';
  }
  
  // Check procedural
  if (matchesPatterns(normalizedQuery, QUERY_TYPE_PATTERNS.procedural)) {
    return 'procedural';
  }
  
  // Check conceptual
  if (matchesPatterns(normalizedQuery, QUERY_TYPE_PATTERNS.conceptual)) {
    return 'conceptual';
  }
  
  // Check factual
  if (matchesPatterns(normalizedQuery, QUERY_TYPE_PATTERNS.factual)) {
    return 'factual';
  }
  
  // Default fallback based on question structure
  if (normalizedQuery.includes('?') || /^(what|who|when|where|why|how|which|is|are|do|does|can|could|would|should)\b/i.test(normalizedQuery)) {
    return 'factual';
  }
  
  // If it looks like just random characters or short non-questions
  if (originalQuery.length < 10 && !/[a-zA-Z]{3,}/.test(originalQuery)) {
    return 'conversational';
  }
  
  return 'factual';
}

/**
 * Detect query subtype for more specific categorization.
 *
 * @param normalizedQuery - Lowercase, trimmed query text
 * @param type - Primary query type
 * @returns Optional subtype string
 */
function detectSubtype(normalizedQuery: string, type: QueryType): string | undefined {
  if (type === 'factual') {
    if (matchesPatterns(normalizedQuery, SUBTYPE_PATTERNS.definition)) {
      return 'definition';
    }
    if (matchesPatterns(normalizedQuery, SUBTYPE_PATTERNS.quantitative)) {
      return 'quantitative';
    }
    if (matchesPatterns(normalizedQuery, SUBTYPE_PATTERNS.temporal)) {
      return 'temporal';
    }
  }
  
  if (type === 'procedural') {
    if (matchesPatterns(normalizedQuery, SUBTYPE_PATTERNS.troubleshooting)) {
      return 'troubleshooting';
    }
    if (matchesPatterns(normalizedQuery, SUBTYPE_PATTERNS.stepByStep)) {
      return 'step-by-step';
    }
  }
  
  return undefined;
}

/**
 * Determine if retrieval is needed based on query characteristics and context.
 *
 * @param normalizedQuery - Lowercase, trimmed query text
 * @param type - Detected query type
 * @param context - Optional context (domain, collections, history)
 * @param threshold - Confidence threshold (unused in current implementation)
 * @param originalQuery - Original query for acronym detection
 * @returns true if retrieval is recommended
 */
function checkNeedsRetrieval(
  normalizedQuery: string,
  type: QueryType,
  context?: ClassifyQueryInput['context'],
  threshold: number = 0.5,
  originalQuery?: string
): boolean {
  // Conversational queries don't need retrieval
  if (type === 'conversational') {
    return false;
  }
  
  // Math/logic queries don't need retrieval
  if (matchesPatterns(normalizedQuery, RETRIEVAL_BYPASS_PATTERNS.math)) {
    return false;
  }
  
  // General knowledge queries don't need retrieval
  if (matchesPatterns(normalizedQuery, RETRIEVAL_BYPASS_PATTERNS.generalKnowledge)) {
    return false;
  }
  
  // Domain-specific queries need retrieval
  if (context?.domain) {
    return true;
  }
  
  // Document-specific queries need retrieval
  if (matchesPatterns(normalizedQuery, RETRIEVAL_REQUIRED_PATTERNS.document)) {
    return true;
  }
  
  // Queries referencing available collections need retrieval
  if (context?.available_collections && context.available_collections.length > 0) {
    return true;
  }
  
  // Follow-up queries with history need retrieval
  if (context?.user_history && context.user_history.length > 0) {
    // Check if the query looks like a follow-up
    if (/\b(other|more|another|else|also|too|next|previous)\b/i.test(normalizedQuery)) {
      return true;
    }
    // Check if the history mentions documents/sections
    const historyText = context.user_history.join(' ').toLowerCase();
    if (/\b(section|manual|document|chapter|page)\b/i.test(historyText)) {
      return true;
    }
  }
  
  // Navigational queries typically need retrieval
  if (type === 'navigational') {
    return true;
  }
  
  // Conceptual queries about specialized topics need retrieval
  if (type === 'conceptual') {
    return true;
  }
  
  // Procedural queries often need retrieval for domain-specific procedures
  if (type === 'procedural') {
    return true;
  }
  
  // Complex and medium complexity queries typically need retrieval
  const complexity = assessComplexity(normalizedQuery);
  if (complexity === 'complex' || complexity === 'medium') {
    return true;
  }
  
  // Queries with specific technical terms/codes need retrieval
  if (matchesPatterns(normalizedQuery, RETRIEVAL_REQUIRED_PATTERNS.keyword)) {
    return true;
  }
  
  // Check for domain-specific acronyms (not common ones)
  const queryToCheck = originalQuery || normalizedQuery;
  if (/\b[A-Z]{2,6}\b/.test(queryToCheck) && !COMMON_ACRONYMS.test(queryToCheck)) {
    return true;
  }
  
  // Default: don't need retrieval for simple questions LLM can answer
  return false;
}

/**
 * Assess the complexity of a query for retrieval depth planning.
 *
 * @param normalizedQuery - Lowercase, trimmed query text
 * @returns QueryComplexity assessment
 */
function assessComplexity(normalizedQuery: string): QueryComplexity {
  // Check for complex patterns first
  if (matchesPatterns(normalizedQuery, COMPLEXITY_PATTERNS.complex)) {
    return 'complex';
  }
  
  // Check for medium complexity patterns
  if (matchesPatterns(normalizedQuery, COMPLEXITY_PATTERNS.medium)) {
    return 'medium';
  }
  
  // Long queries tend to be more complex
  const wordCount = normalizedQuery.split(/\s+/).filter(w => w.length > 0).length;
  if (wordCount > 20) {
    return 'medium';
  }
  
  // Short simple queries
  return 'simple';
}

/**
 * Calculate confidence score for the classification.
 *
 * @param normalizedQuery - Lowercase, trimmed query text
 * @param type - Detected query type
 * @param context - Optional context for confidence boosting
 * @returns Confidence score between 0 and 1
 */
function calculateConfidence(
  normalizedQuery: string,
  type: QueryType,
  context?: ClassifyQueryInput['context']
): number {
  let confidence = 0.7; // Base confidence
  
  // Pattern match strength affects confidence
  const patterns = QUERY_TYPE_PATTERNS[type];
  const matchCount = countPatternMatches(normalizedQuery, patterns);
  
  if (matchCount > 1) {
    confidence += 0.15;
  } else if (matchCount === 1) {
    confidence += 0.1;
  }
  
  // Context increases confidence
  if (context?.domain) {
    confidence += 0.05;
  }
  
  // Cap at 1.0
  return Math.min(confidence, 1.0);
}

/**
 * Determine the optimal search mode for retrieval.
 *
 * @param normalizedQuery - Lowercase, trimmed query text
 * @param type - Detected query type
 * @returns Recommended SearchMode
 */
function determineSearchMode(normalizedQuery: string, type: QueryType): SearchMode {
  // Keyword mode for specific term lookups (codes, references)
  if (matchesPatterns(normalizedQuery, RETRIEVAL_REQUIRED_PATTERNS.keyword)) {
    return 'keyword';
  }
  
  // Semantic mode for conceptual queries
  if (type === 'conceptual') {
    return 'semantic';
  }
  
  // Check for mixed content (section references + natural language)
  if (/\bsection\b.*\bsay\b/i.test(normalizedQuery) || 
      /\bwhat does\b.*\b\d+\b/i.test(normalizedQuery)) {
    return 'hybrid';
  }
  
  // Default to hybrid for most queries
  return 'hybrid';
}

/**
 * Generate retrieval configuration hints based on query analysis.
 *
 * @param normalizedQuery - Lowercase, trimmed query text
 * @param type - Detected query type
 * @param complexity - Assessed complexity
 * @param context - Optional context for filters
 * @returns Retrieval hints object
 */
function generateRetrievalHints(
  normalizedQuery: string,
  type: QueryType,
  complexity: QueryComplexity,
  context?: ClassifyQueryInput['context']
): ClassifyQueryResult['retrieval_hints'] {
  // Determine top_k based on complexity
  const topKMap: Record<QueryComplexity, number> = {
    simple: 3,
    medium: 7,
    complex: 15,
  };
  const suggestedTopK = topKMap[complexity];
  
  // Determine search mode
  const suggestedMode = determineSearchMode(normalizedQuery, type);
  
  // Build filters if context is provided
  let filters: Record<string, string> | undefined;
  if (context?.domain) {
    filters = { domain: context.domain };
  }
  if (context?.available_collections && context.available_collections.length > 0) {
    filters = filters || {};
    filters['collections'] = context.available_collections.join(',');
  }
  
  return {
    suggested_top_k: suggestedTopK,
    suggested_mode: suggestedMode,
    filters,
  };
}

/**
 * Generate human-readable reasoning explanation.
 *
 * @param type - Detected query type
 * @param needsRetrieval - Whether retrieval is needed
 * @param complexity - Assessed complexity
 * @param subtype - Optional subtype
 * @returns Reasoning string
 */
function generateReasoning(
  type: QueryType,
  needsRetrieval: boolean,
  complexity: QueryComplexity,
  subtype?: string
): string {
  const parts: string[] = [];
  
  parts.push(`Query classified as ${type}${subtype ? ` (${subtype})` : ''}.`);
  parts.push(`Complexity assessed as ${complexity}.`);
  
  if (needsRetrieval) {
    parts.push('Retrieval is recommended for this query.');
  } else {
    parts.push('No retrieval needed - query can be answered directly.');
  }
  
  return parts.join(' ');
}

// ============================================================================
// Main Implementation
// ============================================================================

/**
 * Classify a query to determine if RAG retrieval is needed and categorize the query type.
 *
 * This tool analyzes user queries using pattern matching heuristics to:
 * 1. Detect query type (factual, procedural, conceptual, navigational, conversational)
 * 2. Assess query complexity (simple, medium, complex)
 * 3. Determine if retrieval is needed based on query and context
 * 4. Provide retrieval hints (top_k, search mode, filters)
 *
 * @param input - The classification input containing query, context, and options
 * @returns Classification result with type, complexity, retrieval hints, etc.
 * @throws {ToolError} INVALID_INPUT - If query is empty or whitespace-only
 *
 * @example Basic usage
 * ```typescript
 * const result = await classifyQuery({
 *   query: "What is the boiling point of water?"
 * });
 * // result.classification.type === "factual"
 * // result.needs_retrieval === false (general knowledge)
 * ```
 *
 * @example With domain context
 * ```typescript
 * const result = await classifyQuery({
 *   query: "What are the ventilation requirements?",
 *   context: { domain: "mining-safety" }
 * });
 * // result.needs_retrieval === true (domain-specific)
 * // result.retrieval_hints.filters.domain === "mining-safety"
 * ```
 *
 * @example Complex query
 * ```typescript
 * const result = await classifyQuery({
 *   query: "Compare and contrast all three frameworks",
 *   options: { include_reasoning: true }
 * });
 * // result.complexity === "complex"
 * // result.retrieval_hints.suggested_top_k === 15
 * ```
 */
export async function classifyQuery(input: ClassifyQueryInput): Promise<ClassifyQueryResult> {
  const { query, context, options } = input;
  
  // Validate query is not empty or whitespace-only
  const trimmedQuery = query.trim();
  if (trimmedQuery.length === 0) {
    throw createToolError('INVALID_INPUT', 'Query cannot be empty or whitespace-only', {
      suggestion: 'Provide a non-empty query string',
      recoverable: false,
    });
  }
  
  // Normalize for pattern matching
  const normalizedQuery = trimmedQuery.toLowerCase();
  
  // 1. Detect query type
  const type = detectQueryType(normalizedQuery, query);
  
  // 2. Detect subtype
  const subtype = detectSubtype(normalizedQuery, type);
  
  // 3. Determine if retrieval is needed
  const threshold = options?.threshold ?? 0.5;
  const needsRetrieval = checkNeedsRetrieval(normalizedQuery, type, context, threshold, trimmedQuery);
  
  // 4. Assess complexity
  const complexity = assessComplexity(normalizedQuery);
  
  // 5. Calculate confidence
  const confidence = calculateConfidence(normalizedQuery, type, context);
  
  // 6. Generate retrieval hints (only if retrieval is needed)
  const retrievalHints = needsRetrieval 
    ? generateRetrievalHints(normalizedQuery, type, complexity, context)
    : undefined;
  
  // 7. Generate reasoning if requested
  const reasoning = options?.include_reasoning 
    ? generateReasoning(type, needsRetrieval, complexity, subtype)
    : undefined;
  
  // 8. Build and return result
  return {
    query,
    needs_retrieval: needsRetrieval,
    confidence,
    classification: {
      type,
      subtype,
    },
    complexity,
    retrieval_hints: retrievalHints,
    reasoning,
  };
}
