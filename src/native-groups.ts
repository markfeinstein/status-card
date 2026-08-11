import type { HassEntity } from "home-assistant-js-websocket";

export type NativeGroupFilter = { key: string; value: unknown };

export function nativeGroupDomains(config: Record<string, unknown>): string[] {
  return Array.isArray(config.domains)
    ? config.domains.map((domain) => String(domain))
    : [];
}

export function nativeGroupExcludePatterns(config: Record<string, unknown>): string[] {
  return Array.isArray(config.exclude_entities)
    ? config.exclude_entities.map((pattern) => String(pattern))
    : [];
}

export function nativeGroupFilters(config: Record<string, unknown>): NativeGroupFilter[] {
  if (Array.isArray(config.filters)) {
    return config.filters
      .filter(
        (filter): filter is { key: unknown; value: unknown } =>
          !!filter &&
          typeof filter === "object" &&
          "key" in filter &&
          "value" in filter,
      )
      .map((filter) => ({ key: String(filter.key), value: filter.value }));
  }

  const filters: NativeGroupFilter[] = [];
  if (config.state !== undefined) {
    filters.push({ key: "state", value: config.state });
  }
  if (config.attributes !== undefined) {
    filters.push({ key: "attributes", value: config.attributes });
  }
  return filters;
}

export function matchNativeGroupPattern(entityId: string, pattern: string): boolean {
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" +
        pattern
          .split("*")
          .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
          .join(".*") +
        "$",
      "i",
    );
    return regex.test(entityId);
  }
  return entityId === pattern;
}

export function matchNativeGroupValue(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected)) {
    return expected.some((value) => matchNativeGroupValue(actual, value));
  }
  if (typeof expected === "string" && expected.startsWith("!")) {
    return !matchNativeGroupValue(actual, expected.slice(1));
  }
  if (
    typeof expected === "string" &&
    /^([<>]=?)\s*(-?\d+(?:\.\d+)?)$/.test(expected)
  ) {
    const [, op, numberText] = expected.match(
      /^([<>]=?)\s*(-?\d+(?:\.\d+)?)$/,
    ) || [undefined, undefined, undefined];
    const wanted = Number(numberText);
    const received = Number(actual);
    if (!Number.isFinite(wanted) || !Number.isFinite(received)) return false;
    if (op === ">") return received > wanted;
    if (op === ">=") return received >= wanted;
    if (op === "<") return received < wanted;
    if (op === "<=") return received <= wanted;
  }
  if (typeof expected === "string" && expected.includes("*")) {
    return matchNativeGroupPattern(String(actual), expected);
  }
  return actual === expected;
}

export function nativeGroupMatchesFilter(
  entity: HassEntity,
  filter: NativeGroupFilter,
): boolean {
  const key = String(filter.key);
  const expected = filter.value;
  if (key === "state") return matchNativeGroupValue(entity.state, expected);
  if (key === "entity_id") {
    return matchNativeGroupValue(entity.entity_id, expected);
  }
  if (key === "name") {
    return matchNativeGroupValue(entity.attributes.friendly_name ?? "", expected);
  }
  if (key === "attributes" && expected && typeof expected === "object") {
    return Object.entries(expected).every(([attrKey, attrExpected]) => {
      const value = attrKey.split(":").reduce<unknown>(
        (current, part) =>
          current && typeof current === "object"
            ? (current as Record<string, unknown>)[part]
            : undefined,
        entity.attributes,
      );
      return matchNativeGroupValue(value, attrExpected);
    });
  }
  return true;
}
