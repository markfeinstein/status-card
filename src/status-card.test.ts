import { describe, expect, it } from "vitest";
import type { HassEntity } from "home-assistant-js-websocket";
import { PropertyValues, render } from "lit";
import { StatusCard } from "./card";
import { StatusCardPopup } from "./popup-dialog";
import type { HomeAssistant, LovelaceCardConfig } from "./ha";
import { isEntityActive } from "./helpers";

const state = (
  entity_id: string,
  stateValue: string,
  attributes: Record<string, any> = {},
): HassEntity =>
  ({
    entity_id,
    state: stateValue,
    attributes,
    last_changed: "2026-01-01T00:00:00.000Z",
    last_updated: "2026-01-01T00:00:00.000Z",
    context: { id: "synthetic-context" },
  }) as HassEntity;

const registryEntries = (ids: string[]): HomeAssistant["entities"] =>
  Object.fromEntries(ids.map((entity_id) => [entity_id, { entity_id }]));

const hass = (
  states: Record<string, HassEntity>,
  overrides: Partial<HomeAssistant> = {},
): HomeAssistant =>
  ({
    states,
    entities: {},
    devices: {},
    areas: {},
    themes: {},
    locale: { language: "en" },
    language: "en",
    localize: (_key: string) => "localized",
    ...overrides,
  }) as HomeAssistant;

const statesWithoutOwnKeys = (
  states: Record<string, HassEntity>,
  onOwnKeys: () => void,
): Record<string, HassEntity> =>
  new Proxy(states, {
    ownKeys() {
      onOwnKeys();
      throw new Error("states ownKeys should not be used on ordinary updates");
    },
  });

const changed = (oldHass: HomeAssistant): PropertyValues =>
  new Map([["hass", oldHass]]) as PropertyValues;

const card = (
  config: LovelaceCardConfig,
  states: Record<string, HassEntity>,
  overrides: Partial<HomeAssistant> = {},
) => {
  const el = new StatusCard();
  el.setConfig(config);
  el.hass = hass(states, {
    ...overrides,
    entities: overrides.entities ?? registryEntries(Object.keys(states)),
  });
  return el;
};

const sharedHassParts = () => ({
  themes: {},
  entities: {},
  devices: {},
  areas: {},
  locale: { language: "en" },
  localize: (_key: string) => "localized",
});

const trustRegistry = (el: StatusCard, ids: string[]): void => {
  (el as any).__registryEntities = Object.values(registryEntries(ids));
  (el as any).__registryDevices = [];
  (el as any).__registryAreas = [];
  (el as any).__registryDataLoaded = true;
};

const controllableRegistryCallWS = () => {
  const calls: Array<{
    message: { type: string };
    resolve: (value: Array<Record<string, string>>) => void;
  }> = [];
  const callWS: HomeAssistant["callWS"] = <T,>(message: any) =>
    new Promise<T>((resolve) => {
      calls.push({
        message,
        resolve: resolve as (value: Array<Record<string, string>>) => void,
      });
    });
  const resolveNextFetch = (entityIds: string[]) => {
    const batch = calls.splice(0, 3);
    expect(batch.map((call) => call.message.type)).toEqual([
      "config/entity_registry/list",
      "config/device_registry/list",
      "config/area_registry/list",
    ]);
    batch[0].resolve(entityIds.map((entity_id) => ({ entity_id })));
    batch[1].resolve([]);
    batch[2].resolve([]);
  };
  return { calls, callWS, resolveNextFetch };
};

const flushPromises = async () => {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
  }
};

const nativeGroupTabElement = (
  el: StatusCard,
  item: {
    type: "nativeGroup";
    group_id: string;
    order: number;
    config: LovelaceCardConfig;
  },
): Element | null => {
  const host = document.createElement("div");
  render((el as any).renderNativeGroupTab(item), host);
  return host.querySelector("ha-tab-group-tab");
};

describe("active entity semantics", () => {
  it("treats idle climate and humidifier entities as inactive", () => {
    expect(
      isEntityActive(
        state("climate.synthetic_room", "heat", { hvac_action: "idle" }),
        "climate",
      ),
    ).toBe(false);
    expect(
      isEntityActive(
        state("humidifier.synthetic_room", "on", { action: "idle" }),
        "humidifier",
      ),
    ).toBe(false);
  });

  it("uses badge active semantics for popup state sorting in mixed groups", () => {
    const popup = new StatusCardPopup();
    const states = {
      "climate.synthetic_idle": state("climate.synthetic_idle", "heat", {
        friendly_name: "A idle climate",
        hvac_action: "idle",
      }),
      "humidifier.synthetic_idle": state("humidifier.synthetic_idle", "on", {
        friendly_name: "B idle humidifier",
        action: "idle",
      }),
      "switch.synthetic_active": state("switch.synthetic_active", "on", {
        friendly_name: "C active switch",
      }),
      "binary_sensor.synthetic_inverted": state(
        "binary_sensor.synthetic_inverted",
        "off",
        { friendly_name: "D inverted clear", device_class: "problem" },
      ),
    };
    popup.hass = hass(states);
    const popupCardStub = {
      _config: {
        type: "custom:status-card",
        popup_sort: "state",
        customization: [{ type: "binary_sensor - problem", invert: true }],
      },
      getCustomizationForType(type: string) {
        return popupCardStub._config.customization?.find(
          (entry: LovelaceCardConfig) => entry.type === type,
        );
      },
    };
    popup.card = popupCardStub as unknown as StatusCard;

    const sorted = (popup as any).sortEntitiesForPopup(Object.values(states));

    expect(sorted.map((entity) => entity.entity_id)).toEqual([
      "switch.synthetic_active",
      "binary_sensor.synthetic_inverted",
      "climate.synthetic_idle",
      "humidifier.synthetic_idle",
    ]);
  });
});

describe("popup update gating", () => {
  it("rerenders when relevant same-ID-set states change", () => {
    const popup = new StatusCardPopup();
    const oldStates = {
      "switch.synthetic_one": state("switch.synthetic_one", "off"),
      "switch.synthetic_two": state("switch.synthetic_two", "on"),
    };
    const newStates = {
      ...oldStates,
      "switch.synthetic_one": state("switch.synthetic_one", "on"),
    };
    popup.card = { _config: { type: "custom:status-card" } } as StatusCard;
    popup.hass = hass(newStates);
    popup.open = true;
    (popup as any)._allEntities = Object.values(oldStates);
    (popup as any)._activeEntities = [oldStates["switch.synthetic_two"]];
    (popup as any)._lastEntityIds = ["switch.synthetic_two"];

    expect((popup as any).shouldUpdate(changed(hass(oldStates)))).toBe(true);
    expect((popup as any)._currentEntitiesCache.map((entity: HassEntity) => entity.entity_id)).toEqual([
      "switch.synthetic_one",
      "switch.synthetic_two",
    ]);
  });

  it("does not rerender for unrelated state changes", () => {
    const popup = new StatusCardPopup();
    const tracked = state("switch.synthetic_tracked", "on");
    const oldHass = hass({
      "switch.synthetic_tracked": tracked,
      "sensor.synthetic_noise": state("sensor.synthetic_noise", "1"),
    });
    popup.card = { _config: { type: "custom:status-card" } } as StatusCard;
    popup.hass = {
      ...oldHass,
      states: {
        "switch.synthetic_tracked": tracked,
        "sensor.synthetic_noise": state("sensor.synthetic_noise", "2"),
      },
    } as HomeAssistant;
    popup.open = true;
    (popup as any)._allEntities = [tracked];
    (popup as any)._activeEntities = [tracked];
    (popup as any)._lastEntityIds = [tracked.entity_id];

    expect((popup as any).shouldUpdate(changed(oldHass))).toBe(false);
  });

  it("rerenders when hass registry or locale identities change", () => {
    const tracked = state("switch.synthetic_tracked", "on");
    const baseParts = sharedHassParts();
    const oldHass = hass({ "switch.synthetic_tracked": tracked }, baseParts);
    const changes: Partial<HomeAssistant>[] = [
      { entities: {} },
      { devices: {} },
      { areas: {} },
      { locale: { language: "en" } as HomeAssistant["locale"] },
    ];

    for (const override of changes) {
      const popup = new StatusCardPopup();
      popup.card = { _config: { type: "custom:status-card" } } as StatusCard;
      popup.open = true;
      (popup as any)._allEntities = [tracked];
      (popup as any)._activeEntities = [tracked];
      popup.hass = hass({ "switch.synthetic_tracked": tracked }, {
        ...baseParts,
        ...override,
      });

      expect((popup as any).shouldUpdate(changed(oldHass))).toBe(true);
    }
  });

  it("preserves the full entity set supplied to showDialog", () => {
    if (!customElements.get("hui-tile-card")) {
      customElements.define("hui-tile-card", class extends HTMLElement {});
    }
    const active = state("switch.synthetic_active", "on");
    const inactive = state("switch.synthetic_inactive", "off");
    const popup = new StatusCardPopup();
    const popupCard = {
      _config: { type: "custom:status-card" },
      getCustomizationForType: () => undefined,
    } as unknown as StatusCard;

    void popup.showDialog({
      hass: hass({
        "switch.synthetic_active": active,
        "switch.synthetic_inactive": inactive,
      }),
      entities: [active],
      allEntities: [active, inactive],
      card: popupCard,
      initialShowAll: false,
    });

    expect((popup as any)._allEntities.map((entity: HassEntity) => entity.entity_id)).toEqual([
      "switch.synthetic_active",
      "switch.synthetic_inactive",
    ]);
    (popup as any)._showAll = true;
    (popup as any).willUpdate(new Map([["_showAll", false]]));
    expect((popup as any)._entities.map((entity: HassEntity) => entity.entity_id)).toEqual([
      "switch.synthetic_active",
      "switch.synthetic_inactive",
    ]);
  });

  it("keeps ordinary switches in switch device-class popups", () => {
    const popup = new StatusCardPopup();
    popup.selectedDomain = "switch";
    popup.selectedDeviceClass = "switch";

    expect(
      (popup as any)._matchesSelectedType(
        state("switch.synthetic_plain", "on"),
      ),
    ).toBe(true);
    expect(
      (popup as any)._matchesSelectedType(
        state("switch.synthetic_explicit", "on", {
          device_class: "switch",
        }),
      ),
    ).toBe(true);
    expect(
      (popup as any)._matchesSelectedType(
        state("switch.synthetic_outlet", "on", {
          device_class: "outlet",
        }),
      ),
    ).toBe(false);
  });

  it("refreshes entities when selectedDeviceClass changes within the same domain", () => {
    const popup = new StatusCardPopup();
    const motion = state("binary_sensor.synthetic_motion", "on", {
      device_class: "motion",
    });
    const door = state("binary_sensor.synthetic_door", "on", {
      device_class: "door",
    });
    popup.card = { _config: { type: "custom:status-card" } } as StatusCard;
    popup.hass = hass({
      "binary_sensor.synthetic_motion": motion,
      "binary_sensor.synthetic_door": door,
    });
    popup.open = true;
    popup.selectedDomain = "binary_sensor";
    popup.selectedDeviceClass = "motion";
    (popup as any)._allEntities = [motion, door];
    (popup as any)._activeEntities = [motion, door];

    (popup as any).willUpdate(new Map([["selectedDeviceClass", "door"]]));

    expect((popup as any)._entities.map((entity: HassEntity) => entity.entity_id)).toEqual([
      "binary_sensor.synthetic_motion",
    ]);
  });

  it("refreshes entities when the popup entity set is replaced", () => {
    const popup = new StatusCardPopup();
    const first = state("switch.synthetic_first", "on");
    const second = state("switch.synthetic_second", "on");
    popup.card = { _config: { type: "custom:status-card" } } as StatusCard;
    popup.hass = hass({
      "switch.synthetic_first": first,
      "switch.synthetic_second": second,
    });
    popup.open = true;
    popup.entities = [second];
    (popup as any)._allEntities = [first];
    (popup as any)._activeEntities = [first];

    (popup as any).willUpdate(new Map([["entities", [first]]]));

    expect((popup as any)._entities.map((entity: HassEntity) => entity.entity_id)).toEqual([
      "switch.synthetic_second",
    ]);
  });
});

describe("native groups", () => {
  const nativeConfig: LovelaceCardConfig = {
    type: "custom:status-card",
    content: ["synthetic-low-batteries"],
    native_groups: [
      {
        type: "native-group",
        group_id: "synthetic-low-batteries",
        domains: ["sensor", "binary_sensor", "sensor"],
        attributes: { device_class: ["battery", "problem"] },
        state: ["< 25", "on"],
        exclude_entities: ["sensor.synthetic_excluded*"],
      },
    ],
  };

  it("filters current states by domain, device_class, numeric thresholds, exclusions, and de-duplicates", () => {
    const el = card(nativeConfig, {
      "sensor.synthetic_low": state("sensor.synthetic_low", "12", { device_class: "battery" }),
      "sensor.synthetic_high": state("sensor.synthetic_high", "92", { device_class: "battery" }),
      "sensor.synthetic_excluded_battery": state("sensor.synthetic_excluded_battery", "5", { device_class: "battery" }),
      "binary_sensor.synthetic_problem": state("binary_sensor.synthetic_problem", "on", { device_class: "problem" }),
      "binary_sensor.synthetic_clear": state("binary_sensor.synthetic_clear", "off", { device_class: "problem" }),
      "light.synthetic_unrelated": state("light.synthetic_unrelated", "on"),
    });

    expect((el as any)._nativeGroupEntities(nativeConfig.native_groups![0]).map((entity) => entity.entity_id)).toEqual([
      "sensor.synthetic_low",
      "binary_sensor.synthetic_problem",
    ]);
  });

  it("evaluates device_class and threshold filters against current state objects", () => {
    const config = nativeConfig.native_groups![0];
    const oldStates = {
      "sensor.synthetic_candidate": state("sensor.synthetic_candidate", "40", { device_class: "temperature" }),
    };
    const newStates = {
      "sensor.synthetic_candidate": state("sensor.synthetic_candidate", "10", { device_class: "battery" }),
    };
    const el = card(nativeConfig, newStates);

    expect((el as any)._nativeGroupEntities(config).map((entity) => entity.entity_id)).toEqual([
      "sensor.synthetic_candidate",
    ]);
    expect((el as any)._hasRelevantHassStateChange(hass(oldStates), hass(newStates))).toBe(true);
  });

  it("detects registry-backed new sensor IDs without states ownKeys enumeration", () => {
    const oldStates = {
      "sensor.synthetic_existing": state("sensor.synthetic_existing", "10", { device_class: "battery" }),
    };
    const newStates = {
      ...oldStates,
      "sensor.synthetic_added": state("sensor.synthetic_added", "9", { device_class: "battery" }),
    };
    const sharedThemes = {};
    const sharedDevices = {};
    const sharedAreas = {};
    const oldHass = hass(oldStates, {
      entities: registryEntries(["sensor.synthetic_existing"]),
      themes: sharedThemes,
      devices: sharedDevices,
      areas: sharedAreas,
    });
    let ownKeysCount = 0;
    const newHass = hass(statesWithoutOwnKeys(newStates, () => ownKeysCount++), {
      entities: registryEntries([
        "sensor.synthetic_existing",
        "sensor.synthetic_added",
      ]),
      themes: sharedThemes,
      devices: sharedDevices,
      areas: sharedAreas,
    });
    const el = card(nativeConfig, oldStates, { entities: oldHass.entities });
    trustRegistry(el, ["sensor.synthetic_existing"]);
    el.hass = newHass;

    expect((el as any).shouldUpdate(changed(oldHass))).toBe(true);
    expect((el as any)._nativeGroupEntities(nativeConfig.native_groups![0]).map((entity: HassEntity) => entity.entity_id)).toEqual([
      "sensor.synthetic_existing",
      "sensor.synthetic_added",
    ]);
    expect(ownKeysCount).toBe(0);
  });

  it("does not enumerate hass.states at index build or ordinary native updates", () => {
    const config = nativeConfig.native_groups![0];
    const baseStates = {
      "sensor.synthetic_low": state("sensor.synthetic_low", "12", { device_class: "battery" }),
      "sensor.synthetic_noise": state("sensor.synthetic_noise", "1", { device_class: "temperature" }),
    };
    const shared = {
      ...sharedHassParts(),
      entities: registryEntries([
        "sensor.synthetic_low",
        "sensor.synthetic_noise",
      ]),
    };
    let ownKeysCount = 0;
    const oldStates = statesWithoutOwnKeys(baseStates, () => ownKeysCount++);
    const el = card(nativeConfig, oldStates, shared);
    trustRegistry(el, ["sensor.synthetic_low", "sensor.synthetic_noise"]);
    (el as any)._nativeGroupEntities(config);
    expect(ownKeysCount).toBe(0);

    const assertUpdate = (
      states: Record<string, HassEntity>,
      expected: boolean,
    ) => {
      const oldHass = hass(oldStates, shared);
      const newHass = hass(statesWithoutOwnKeys(states, () => ownKeysCount++), shared);
      el.hass = newHass;
      expect((el as any).shouldUpdate(changed(oldHass))).toBe(expected);
    };

    assertUpdate(
      {
        ...baseStates,
        "sensor.synthetic_noise": state("sensor.synthetic_noise", "2", { device_class: "temperature" }),
      },
      false,
    );
    assertUpdate(
      {
        ...baseStates,
        "sensor.synthetic_low": state("sensor.synthetic_low", "30", { device_class: "battery" }),
      },
      true,
    );
    assertUpdate(
      {
        ...baseStates,
        "sensor.synthetic_noise": state("sensor.synthetic_noise", "2", { device_class: "battery" }),
      },
      true,
    );
    expect(ownKeysCount).toBe(0);
  });

  it("uses state fallback while the fetched registry has not loaded", () => {
    const config = nativeConfig.native_groups![0];
    const states = {
      "sensor.synthetic_low": state("sensor.synthetic_low", "12", { device_class: "battery" }),
      "binary_sensor.synthetic_problem": state("binary_sensor.synthetic_problem", "on", { device_class: "problem" }),
      "sensor.synthetic_noise": state("sensor.synthetic_noise", "1", { device_class: "temperature" }),
    };
    const el = card(nativeConfig, states, { entities: {} });

    expect((el as any)._nativeGroupEntities(config).map((entity: HassEntity) => entity.entity_id)).toEqual([
      "sensor.synthetic_low",
      "binary_sensor.synthetic_problem",
    ]);
  });

  it("does not let a partial frontend registry suppress pending state fallback", () => {
    const config = nativeConfig.native_groups![0];
    const states = {
      "sensor.synthetic_low": state("sensor.synthetic_low", "12", { device_class: "battery" }),
      "binary_sensor.synthetic_problem": state("binary_sensor.synthetic_problem", "on", { device_class: "problem" }),
      "sensor.synthetic_noise": state("sensor.synthetic_noise", "1", { device_class: "temperature" }),
    };
    const oldHass = hass(states, { entities: registryEntries(Object.keys(states)) });
    const el = card(nativeConfig, states, { entities: oldHass.entities });

    expect((el as any)._nativeGroupEntities(config).map((entity: HassEntity) => entity.entity_id)).toEqual([
      "sensor.synthetic_low",
      "binary_sensor.synthetic_problem",
    ]);

    el.hass = hass(states, {
      entities: registryEntries(["sensor.synthetic_noise"]),
    });

    expect((el as any).shouldUpdate(changed(oldHass))).toBe(true);
    expect((el as any)._nativeGroupEntities(config).map((entity: HassEntity) => entity.entity_id)).toEqual([
      "sensor.synthetic_low",
      "binary_sensor.synthetic_problem",
    ]);
  });

  it("keeps a native-group tab renderable while registry fetch is pending", () => {
    const config = nativeConfig.native_groups![0];
    const states = {
      "sensor.synthetic_low": state("sensor.synthetic_low", "12", { device_class: "battery" }),
    };
    const el = card(nativeConfig, states, { entities: {} });
    const item = {
      type: "nativeGroup" as const,
      group_id: "synthetic-low-batteries",
      order: 0,
      config,
    };

    const template = (el as any).renderNativeGroupTab(item);

    expect(template.strings.join("")).toContain("ha-tab-group-tab");
  });

  it("rebuilds a native group index when fetched registry entities arrive", () => {
    const config = nativeConfig.native_groups![0];
    const states = {
      "sensor.synthetic_low": state("sensor.synthetic_low", "12", { device_class: "battery" }),
      "binary_sensor.synthetic_problem": state("binary_sensor.synthetic_problem", "on", { device_class: "problem" }),
      "sensor.synthetic_state_only": state("sensor.synthetic_state_only", "9", { device_class: "battery" }),
    };
    const el = card(nativeConfig, states, {
      entities: registryEntries(["sensor.synthetic_low"]),
    });

    expect((el as any)._nativeGroupEntities(config).map((entity: HassEntity) => entity.entity_id)).toEqual([
      "sensor.synthetic_low",
      "sensor.synthetic_state_only",
      "binary_sensor.synthetic_problem",
    ]);

    trustRegistry(el, ["sensor.synthetic_low", "binary_sensor.synthetic_problem"]);

    expect((el as any)._nativeGroupEntities(config).map((entity: HassEntity) => entity.entity_id)).toEqual([
      "sensor.synthetic_low",
      "binary_sensor.synthetic_problem",
    ]);
  });

  it("refreshes fetched registries with a controllable callWS lifecycle", async () => {
    const config = nativeConfig.native_groups![0];
    const states = {
      "sensor.synthetic_low": state("sensor.synthetic_low", "12", { device_class: "battery" }),
      "binary_sensor.synthetic_problem": state("binary_sensor.synthetic_problem", "on", { device_class: "problem" }),
      "sensor.synthetic_state_only": state("sensor.synthetic_state_only", "9", { device_class: "battery" }),
    };
    const registry = controllableRegistryCallWS();
    const el = card(nativeConfig, states, {
      entities: registryEntries(["sensor.synthetic_low"]),
      callWS: registry.callWS,
    });

    (el as any)._ensureRegistryData();
    expect(registry.calls).toHaveLength(3);
    expect((el as any)._nativeGroupEntities(config).map((entity: HassEntity) => entity.entity_id)).toEqual([
      "sensor.synthetic_low",
      "sensor.synthetic_state_only",
      "binary_sensor.synthetic_problem",
    ]);

    registry.resolveNextFetch(["sensor.synthetic_low", "binary_sensor.synthetic_problem"]);
    await flushPromises();

    expect((el as any).__registryDataLoaded).toBe(true);
    expect((el as any).__registryRefreshRequested).toBe(false);
    expect((el as any)._nativeGroupEntities(config).map((entity: HassEntity) => entity.entity_id)).toEqual([
      "sensor.synthetic_low",
      "binary_sensor.synthetic_problem",
    ]);
  });

  it("runs a follow-up registry fetch when identity changes during an active fetch", async () => {
    const states = {
      "sensor.synthetic_old": state("sensor.synthetic_old", "12", { device_class: "battery" }),
      "sensor.synthetic_new": state("sensor.synthetic_new", "10", { device_class: "battery" }),
    };
    const registry = controllableRegistryCallWS();
    const shared = {
      ...sharedHassParts(),
      callWS: registry.callWS,
    };
    const oldHass = hass(states, {
      ...shared,
      entities: registryEntries(["sensor.synthetic_old"]),
    });
    const el = card(nativeConfig, states, {
      ...shared,
      entities: oldHass.entities,
    });

    (el as any)._ensureRegistryData();
    expect(registry.calls).toHaveLength(3);

    el.hass = hass(states, {
      ...shared,
      entities: registryEntries(["sensor.synthetic_new"]),
    });
    expect((el as any).shouldUpdate(changed(oldHass))).toBe(true);
    expect((el as any).__registryRefreshRequested).toBe(true);

    registry.resolveNextFetch(["sensor.synthetic_old"]);
    await flushPromises();

    expect(registry.calls).toHaveLength(3);
    expect((el as any).__registryRefreshRequested).toBe(true);

    registry.resolveNextFetch(["sensor.synthetic_new"]);
    await flushPromises();

    expect(registry.calls).toHaveLength(0);
    expect((el as any).__registryRefreshRequested).toBe(false);
    expect((el as any)._nativeGroupEntities(nativeConfig.native_groups![0]).map((entity: HassEntity) => entity.entity_id)).toEqual([
      "sensor.synthetic_new",
    ]);
  });

  it("keeps state fallback until the latest registry refresh succeeds", async () => {
    const config = nativeConfig.native_groups![0];
    const states = {
      "sensor.synthetic_live": state("sensor.synthetic_live", "12", { device_class: "battery" }),
    };
    const registry = controllableRegistryCallWS();
    const shared = {
      ...sharedHassParts(),
      callWS: registry.callWS,
    };
    const oldHass = hass(states, {
      ...shared,
      entities: {},
    });
    const el = card(nativeConfig, states, {
      ...shared,
      entities: oldHass.entities,
    });
    const item = {
      type: "nativeGroup" as const,
      group_id: "synthetic-low-batteries",
      order: 0,
      config,
    };

    expect((el as any)._nativeGroupEntities(config).map((entity: HassEntity) => entity.entity_id)).toEqual([
      "sensor.synthetic_live",
    ]);
    expect(nativeGroupTabElement(el, item)).not.toBeNull();

    (el as any)._ensureRegistryData();
    expect(registry.calls).toHaveLength(3);

    el.hass = hass(states, {
      ...shared,
      entities: registryEntries(["sensor.synthetic_partial_registry_only"]),
    });
    expect((el as any).shouldUpdate(changed(oldHass))).toBe(true);
    expect((el as any).__registryRefreshRequested).toBe(true);

    registry.resolveNextFetch([]);
    await flushPromises();

    expect(registry.calls).toHaveLength(3);
    expect((el as any).__registryDataLoaded).toBe(false);
    expect((el as any).__registryRefreshRequested).toBe(true);
    expect((el as any)._nativeGroupEntities(config).map((entity: HassEntity) => entity.entity_id)).toEqual([
      "sensor.synthetic_live",
    ]);
    expect(nativeGroupTabElement(el, item)).not.toBeNull();

    registry.resolveNextFetch(["sensor.synthetic_live"]);
    await flushPromises();

    expect(registry.calls).toHaveLength(0);
    expect((el as any).__registryDataLoaded).toBe(true);
    expect((el as any).__registryRefreshRequested).toBe(false);
    expect((el as any).__registryEntities.map((entry: { entity_id: string }) => entry.entity_id)).toEqual([
      "sensor.synthetic_live",
    ]);
    expect((el as any)._nativeGroupEntities(config).map((entity: HassEntity) => entity.entity_id)).toEqual([
      "sensor.synthetic_live",
    ]);
    expect(nativeGroupTabElement(el, item)).not.toBeNull();
  });

  it("keeps one configured-domain index across multiple native groups", () => {
    const multiGroupConfig: LovelaceCardConfig = {
      type: "custom:status-card",
      content: ["synthetic-lights", "synthetic-batteries"],
      native_groups: [
        {
          type: "native-group",
          group_id: "synthetic-lights",
          domains: ["light"],
        },
        {
          type: "native-group",
          group_id: "synthetic-batteries",
          domains: ["sensor"],
          attributes: { device_class: "battery" },
          state: "<20",
        },
      ],
    };
    const baseStates = {
      "light.synthetic_main": state("light.synthetic_main", "off"),
      "sensor.synthetic_battery": state("sensor.synthetic_battery", "10", {
        device_class: "battery",
      }),
      "sensor.synthetic_noise": state("sensor.synthetic_noise", "1", {
        device_class: "temperature",
      }),
    };
    const shared = {
      ...sharedHassParts(),
      entities: registryEntries(Object.keys(baseStates)),
    };
    const oldHass = hass(baseStates, shared);
    const el = card(multiGroupConfig, baseStates, shared);
    trustRegistry(el, Object.keys(baseStates));
    for (const group of multiGroupConfig.native_groups!) {
      (el as any)._nativeGroupEntities(group);
    }

    let ownKeysCount = 0;
    const newHass = hass(
      statesWithoutOwnKeys(
        {
          ...baseStates,
          "sensor.synthetic_noise": state("sensor.synthetic_noise", "2", {
            device_class: "temperature",
          }),
        },
        () => ownKeysCount++,
      ),
      shared,
    );
    el.hass = newHass;

    expect((el as any).shouldUpdate(changed(oldHass))).toBe(false);
    expect((el as any)._nativeGroupDomainIndexCache.domainsKey).toBe(
      "light\u0000sensor",
    );
    expect(ownKeysCount).toBe(0);
  });

  it("can build native groups from entity_id filters without an explicit domain list", () => {
    const config: LovelaceCardConfig = {
      type: "custom:status-card",
      content: ["synthetic-comfort"],
      native_groups: [
        {
          type: "native-group",
          group_id: "synthetic-comfort",
          filters: [
            {
              key: "entity_id",
              value: ["climate.synthetic_*", "fan.synthetic_*"],
            },
          ],
          exclude_entities: ["climate.synthetic_source"],
        },
      ],
    };
    const el = card(config, {
      "climate.synthetic_room": state("climate.synthetic_room", "heat", { hvac_action: "idle" }),
      "climate.synthetic_source": state("climate.synthetic_source", "heat", { hvac_action: "idle" }),
      "fan.synthetic_room": state("fan.synthetic_room", "off"),
      "light.synthetic_room": state("light.synthetic_room", "on"),
    });

    expect((el as any)._nativeGroupEntities(config.native_groups![0]).map((entity: HassEntity) => entity.entity_id)).toEqual([
      "climate.synthetic_room",
      "fan.synthetic_room",
    ]);
  });

  it("can open a native group popup with all entities while badge visibility can still use active entities", () => {
    const config: LovelaceCardConfig = {
      type: "custom:status-card",
      content: ["synthetic-comfort"],
      native_groups: [
        {
          type: "native-group",
          group_id: "synthetic-comfort",
          domains: ["climate", "fan"],
          popup_entities: "all",
          show_total_entities: false,
          badge_active_count: true,
        },
      ],
    };
    const el = card(config, {
      "climate.synthetic_idle": state("climate.synthetic_idle", "heat", { hvac_action: "idle" }),
      "climate.synthetic_cooling": state("climate.synthetic_cooling", "cool", { hvac_action: "cooling" }),
      "fan.synthetic_off": state("fan.synthetic_off", "off"),
    });
    const calls: any[] = [];
    (el as any)._showPopup = (...args: any[]) => calls.push(args);

    (el as any)._openNativeGroupPopup(0);

    const params = calls[0][2];
    expect(params.entities.map((entity: HassEntity) => entity.entity_id)).toEqual([
      "climate.synthetic_idle",
      "climate.synthetic_cooling",
      "fan.synthetic_off",
    ]);
    expect(params.allEntities.map((entity: HassEntity) => entity.entity_id)).toEqual([
      "climate.synthetic_idle",
      "climate.synthetic_cooling",
      "fan.synthetic_off",
    ]);
    expect(params.initialShowAll).toBe(true);
  });

  it("keeps unknown native filters permissive for compatibility", () => {
    const config: LovelaceCardConfig = {
      type: "custom:status-card",
      content: ["synthetic-unknown-filter"],
      native_groups: [
        {
          type: "native-group",
          group_id: "synthetic-unknown-filter",
          domains: ["sensor"],
          filters: [{ key: "synthetic_unknown_key", value: "not-matched" }],
        },
      ],
    };
    const el = card(config, {
      "sensor.synthetic_kept": state("sensor.synthetic_kept", "ready"),
    });

    expect((el as any)._nativeGroupEntities(config.native_groups![0]).map((entity: HassEntity) => entity.entity_id)).toEqual([
      "sensor.synthetic_kept",
    ]);
  });

  it("invalidates native cache and refreshes registries without dropping fetched entries", () => {
    const shared = sharedHassParts();
    const oldHass = hass({}, {
      ...shared,
      entities: registryEntries(["sensor.synthetic_old"]),
    });
    const newHass = hass({}, {
      ...shared,
      entities: registryEntries(["sensor.synthetic_new"]),
    });
    const el = card(nativeConfig, {}, { entities: oldHass.entities });
    (el as any).__registryEntities = [{ entity_id: "sensor.synthetic_old" }];
    (el as any).__registryDevices = [{ id: "device-old" }];
    (el as any).__registryAreas = [{ area_id: "area-old" }];
    (el as any).__registryDataLoaded = true;
    el.hass = newHass;

    expect((el as any).shouldUpdate(changed(oldHass))).toBe(true);
    expect((el as any)._nativeGroupDomainIndexCache.index).toEqual(new Map());
    expect((el as any).__registryEntities).toEqual([{ entity_id: "sensor.synthetic_old" }]);
    expect((el as any).__registryDevices).toEqual([{ id: "device-old" }]);
    expect((el as any).__registryAreas).toEqual([{ area_id: "area-old" }]);
    expect((el as any).__registryRefreshRequested).toBe(true);
  });

  it("native groups use registry-backed IDs and ignore state-only additions", () => {
    const config = nativeConfig.native_groups![0];
    const states = {
      "sensor.synthetic_registry": state("sensor.synthetic_registry", "10", {
        device_class: "battery",
      }),
      "sensor.synthetic_state_only": state("sensor.synthetic_state_only", "9", {
        device_class: "battery",
      }),
    };
    const el = card(nativeConfig, states, {
      entities: registryEntries(["sensor.synthetic_registry"]),
    });
    trustRegistry(el, ["sensor.synthetic_registry"]);

    expect((el as any)._nativeGroupEntities(config).map((entity: HassEntity) => entity.entity_id)).toEqual([
      "sensor.synthetic_registry",
    ]);
  });

  it("detects unavailable or missing states and ignores irrelevant sensor updates", () => {
    const oldStates = {
      "sensor.synthetic_low": state("sensor.synthetic_low", "12", { device_class: "battery" }),
      "sensor.synthetic_noise": state("sensor.synthetic_noise", "1", { device_class: "temperature" }),
    };
    const unavailableStates = {
      ...oldStates,
      "sensor.synthetic_low": state("sensor.synthetic_low", "unavailable", { device_class: "battery" }),
    };
    const noiseStates = {
      ...oldStates,
      "sensor.synthetic_noise": state("sensor.synthetic_noise", "2", { device_class: "temperature" }),
    };
    const el = card(nativeConfig, oldStates);
    (el as any)._nativeGroupEntities(nativeConfig.native_groups![0]);

    expect((el as any)._hasRelevantHassStateChange(hass(oldStates), hass(unavailableStates))).toBe(true);
    expect((el as any)._hasRelevantHassStateChange(hass(oldStates), hass(noiseStates))).toBe(false);
  });
});
