import {
  createTextLedgerService,
  SOURCE_TYPES
} from "./text-ledger-service.mjs";

import {
  createTextLedgerExtraService,
  EXTRA_SOURCE_TYPES
} from "./text-ledger-extra-service.mjs";


const CORE_TYPES = new Set(
  Object.values(SOURCE_TYPES)
);
const EXTRA_TYPES = new Set(
  Object.values(EXTRA_SOURCE_TYPES)
);


function normalizeText(value) {
  return String(value ?? "").trim();
}


function normalizeLimit(value) {
  return Math.min(
    250,
    Math.max(1, Number(value) || 100)
  );
}


export function resolveLedgerServiceGroup(
  sourceType
) {
  const type = normalizeText(sourceType);

  if (!type) {
    return "all";
  }

  if (CORE_TYPES.has(type)) {
    return "core";
  }

  if (EXTRA_TYPES.has(type)) {
    return "extra";
  }

  const error = new Error(
    "不认识这种文字来源"
  );
  error.code = "invalid_text_source_type";
  error.status = 400;
  throw error;
}


export function createTextLedgerCompositeService({
  serviceClient
}) {
  if (!serviceClient) {
    throw new Error(
      "创建 textLedgerCompositeService 时缺少 serviceClient"
    );
  }

  const core = createTextLedgerService({
    serviceClient
  });
  const extra = createTextLedgerExtraService({
    serviceClient
  });

  function selectService(sourceType) {
    const group = resolveLedgerServiceGroup(
      sourceType
    );

    if (group === "core") {
      return core;
    }

    if (group === "extra") {
      return extra;
    }

    return null;
  }


  async function listItems({
    userId,
    sourceType = null,
    archived = false,
    limit = 100
  }) {
    const safeLimit = normalizeLimit(limit);
    const selectedService =
      selectService(sourceType);

    if (selectedService) {
      return selectedService.listItems({
        userId,
        sourceType,
        archived,
        limit: safeLimit
      });
    }

    const [coreItems, extraItems] =
      await Promise.all([
        core.listItems({
          userId,
          archived,
          limit: safeLimit
        }),
        extra.listItems({
          userId,
          archived,
          limit: safeLimit
        })
      ]);

    return [
      ...(coreItems ?? []),
      ...(extraItems ?? [])
    ]
      .sort((left, right) => (
        new Date(right.occurredAt ?? 0) -
        new Date(left.occurredAt ?? 0)
      ))
      .slice(0, safeLimit);
  }


  async function getItem(input) {
    return selectService(
      input.sourceType
    ).getItem(input);
  }


  async function setArchived(input) {
    return selectService(
      input.sourceType
    ).setArchived(input);
  }


  async function deleteItem(input) {
    return selectService(
      input.sourceType
    ).deleteItem(input);
  }


  return {
    listItems,
    getItem,
    setArchived,
    deleteItem
  };
}


export const TEXT_LEDGER_SOURCE_TYPES =
  Object.freeze({
    ...SOURCE_TYPES,
    ...EXTRA_SOURCE_TYPES
  });
