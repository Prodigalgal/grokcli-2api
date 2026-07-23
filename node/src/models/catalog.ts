export interface StoredModel {
  readonly id: string;
  readonly name: string | null;
  readonly description: string | null;
  readonly ownedBy: string;
  readonly synthetic: boolean;
  readonly contextWindow: number | null;
  readonly supportsReasoningEffort: boolean | null;
  readonly extra: Record<string, unknown>;
  readonly sortOrder: number;
}

export interface ModelStore {
  listPublicModels(): readonly StoredModel[];
}

type PublicModel = Record<string, unknown>;

function sortOrderFor(id: string, defaultModel: string): number {
  if (id === defaultModel) {
    return 0;
  }
  if (id === "grok-build") {
    return 1;
  }
  if (id === "grok-search") {
    return 2;
  }
  return 9;
}

function storedEntry(model: StoredModel, created: number): PublicModel {
  const output: PublicModel = {
    id: model.id,
    object: "model",
    created,
    owned_by: model.ownedBy || "xai",
  };
  if (model.name) {
    output.name = model.name;
  }
  if (model.description) {
    output.description = model.description;
  }
  if (model.contextWindow !== null) {
    output.context_window = model.contextWindow;
  }
  if (model.supportsReasoningEffort !== null) {
    output.supports_reasoning_effort = model.supportsReasoningEffort;
  }
  for (const field of ["max_completion_tokens", "reasoning_effort", "reasoning_efforts", "auto_compact_threshold_percent", "supported_in_api"]) {
    if (model.extra[field] !== undefined && model.extra[field] !== null) {
      output[field] = model.extra[field];
    }
  }
  return output;
}

function localAliases(created: number): PublicModel[] {
  return [
    {
      id: "grok-build",
      object: "model",
      created,
      owned_by: "xai",
      name: "Grok Build",
      description: "Grok coding / build model",
      synthetic: true,
    },
    {
      id: "grok-search",
      object: "model",
      created,
      owned_by: "xai",
      name: "Grok Search",
      description: "Grok with web search enabled (local alias)",
      synthetic: true,
    },
  ];
}

export function openAiModelList(store: ModelStore | null, defaultModel: string, now = Date.now()): Record<string, unknown> {
  const created = Math.floor(now / 1_000);
  const stored = store?.listPublicModels() ?? [];
  const models = stored.length > 0
    ? stored.filter((model) => model.id.trim()).map((model) => storedEntry(model, created))
    : [{ id: defaultModel, object: "model", created, owned_by: "xai" } as PublicModel];
  const seen = new Set(models.map((model) => String(model.id).toLowerCase()));
  for (const alias of localAliases(created)) {
    if (!seen.has(String(alias.id).toLowerCase())) {
      models.push(alias);
    }
  }
  models.sort((left, right) => {
    const order = sortOrderFor(String(left.id), defaultModel) - sortOrderFor(String(right.id), defaultModel);
    return order !== 0 ? order : String(left.id).localeCompare(String(right.id));
  });
  return { object: "list", data: models };
}
