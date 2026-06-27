import { config } from '../config/config.js';
import { AgentRole, StackDomain } from '../types/index.js';

// ---------------------------------------------------------------------------
// selectModel
// ---------------------------------------------------------------------------
// Routing rules (in priority order):
//   1. PM  -> always pm model (claude-sonnet-4-6)
//   2. DEV -> always dev model (claude-sonnet-4-6)
//   3. TESTER + complex domain (blockchain or ai_ml) -> testerComplex model
//   4. TESTER + isSimple=true -> tester (haiku) model
//   5. taskType === "lobby" -> lobby model (haiku)
//   6. Default -> claude-sonnet-4-6
// ---------------------------------------------------------------------------

const COMPLEX_DOMAINS = new Set<StackDomain>([
  StackDomain.BLOCKCHAIN_EVM,
  StackDomain.BLOCKCHAIN_SOL,
  StackDomain.AI_ML,
  StackDomain.GAME,
]);

export function selectModel(params: {
  agent: AgentRole;
  taskType?: string;
  domain?: StackDomain;
  isSimple?: boolean;
}): string {
  const { agent, taskType, domain, isSimple } = params;

  // 1. PM always uses the PM model
  if (agent === AgentRole.PM) {
    return config.anthropic.models.pm;
  }

  // 2. DEV always uses the DEV model
  if (agent === AgentRole.DEV) {
    return config.anthropic.models.dev;
  }

  // 3. TESTER on a complex domain -> testerComplex (sonnet)
  if (agent === AgentRole.TESTER && domain !== undefined && COMPLEX_DOMAINS.has(domain)) {
    return config.anthropic.models.testerComplex;
  }

  // 4. TESTER on a simple task -> cheaper haiku model
  if (agent === AgentRole.TESTER && isSimple === true) {
    return config.anthropic.models.tester;
  }

  // 5. Lobby task type -> haiku model
  if (taskType === 'lobby') {
    return config.anthropic.models.lobby;
  }

  // 6. Default -> sonnet
  return 'claude-sonnet-4-6';
}
