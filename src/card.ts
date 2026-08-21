import { LitElement, html, css, PropertyValues, TemplateResult } from "lit";
import { customElement, property, state } from "lit/decorators.js";
import { repeat } from "lit/directives/repeat.js";
import { classMap } from "lit/directives/class-map.js";
import { styleMap } from "lit/directives/style-map.js";
import { ifDefined } from "lit/directives/if-defined.js";
import memoizeOne from "memoize-one";
import type { HassEntity } from "home-assistant-js-websocket";
import "./popup-dialog";
import { computeLabelCallback } from "./translations";
import {
  getIncludedEntityIds,
  mapIdsToStates,
  typeKey,
  cacheByProperty,
  isEntityActive,
} from "./helpers";
import { ALLOWED_DOMAINS } from "./const";
import {
  HomeAssistant,
  computeDomain,
  hasAction,
  ActionHandlerEvent,
  actionHandler,
  applyThemesOnElement,
  LovelaceCardConfig,
  Schema,
  EntityRegistryEntry,
  DeviceRegistryEntry,
  AreaRegistryEntry,
} from "./ha";
import {
  computeExtraItems,
  computeGroupItems,
  computeDomainItems,
  computeDeviceClassItems,
  getPersonEntityIds,
  mapPersonIdsToStates,
} from "./card-items";
import {
  Ruleset,
  DomainItem,
  DeviceClassItem,
  ExtraItem,
  AnyItem,
  GroupItem,
  StatusCardLike,
  StatusCardPopupDialogParams,
} from "./ha/types";
import {
  filterEntitiesByRuleset,
  filterStaticEntities,
  filterDynamicEntities,
} from "./smart_groups";
import {
  matchNativeGroupPattern,
  nativeGroupEntityPatterns,
  nativeGroupExcludePatterns,
  nativeGroupFilters,
  nativeGroupMatchesFilter,
  nativeGroupSourceDomains,
} from "./native-groups";
import {
  getBackgroundColor,
  getCustomColor,
  getCustomIcon,
  getCustomName,
  getCustomizationForType,
  getStatusProperty,
  getIconStyles,
  customizationIndex,
  parseCss,
  getParsedCss,
  cardStyles,
} from "./card-styles";
import { handleDomainAction, toggleDomain } from "./card-actions";
import { mdiFormatListGroup } from "@mdi/js";

@customElement("status-card")
export class StatusCard extends LitElement {
  @property({ type: Object }) public _config!: LovelaceCardConfig;
  @state() private entitiesByDomain: { [domain: string]: HassEntity[] } = {};
  @state() public selectedDomain: string | null = null;
  @state() public selectedDeviceClass: string | null = null;
  @state() public hiddenEntities: string[] = [];
  @state() private hiddenLabels: string[] = [];
  @state() private hiddenAreas: string[] = [];
  @state() private hide_person: boolean = false;
  @state() private hide_content_name: boolean = true;
  @state() public list_mode: boolean = false;
  @state() public badge_mode: boolean = false;
  @state() public no_background: boolean = false;
  @state() public badge_color: string = "";
  @state() public badge_text_color: string = "";
  @state() public selectedGroup: number | null = null;
  @state() public selectedNativeGroup: number | null = null;

  @property({ attribute: false }) public hass!: HomeAssistant;

  @state() public _shouldHideCard: boolean = false;
  @state() public __registryEntities: EntityRegistryEntry[] = [];
  @state() public __registryDevices: DeviceRegistryEntry[] = [];
  @state() public __registryAreas: AreaRegistryEntry[] = [];
  @state() private __registryFetchInProgress: boolean = false;
  @state() private _parsedGlobalCss: Record<string, string> = {};
  @state() private _parsedGlobalIconCss: Record<string, string> = {};
  @state() private _parsedGlobalCardCss: Record<string, string> = {};
  @state() private _parsedGlobalNameCss: Record<string, string> = {};
  @state() private _parsedGlobalStateCss: Record<string, string> = {};
  private _resetDomainTimeout?: ReturnType<typeof setTimeout>;
  private _resetGroupTimeout?: ReturnType<typeof setTimeout>;
  private _resetNativeGroupTimeout?: ReturnType<typeof setTimeout>;
  private _nativeGroupDomainIndexCache: {
    domainsKey: string;
    entities: HomeAssistant["entities"] | undefined;
    index: Map<string, string[]>;
  } = { domainsKey: "", entities: undefined, index: new Map() };

  private _invalidateRegistryData(): void {
    this.__registryEntities = [];
    this.__registryDevices = [];
    this.__registryAreas = [];
    this.__registryFetchInProgress = false;
  }

  private _ensureRegistryData(): void {
    if (
      this.__registryEntities.length ||
      !this.hass ||
      typeof this.hass.callWS !== "function" ||
      this.__registryFetchInProgress
    ) {
      return;
    }

    this.__registryFetchInProgress = true;
    Promise.all([
      cacheByProperty<EntityRegistryEntry>(this.hass, "entity", "entity_id"),
      cacheByProperty<DeviceRegistryEntry>(this.hass, "device", "id"),
      cacheByProperty<AreaRegistryEntry>(this.hass, "area", "area_id"),
    ])
      .then(([entityMap, deviceMap, areaMap]) => {
        this.__registryEntities = Object.values(entityMap);
        this.__registryDevices = Object.values(deviceMap);
        this.__registryAreas = Object.values(areaMap);
      })
      .catch((e) => {
        console.error("Error fetching registry data", e);
      })
      .finally(() => {
        this.__registryFetchInProgress = false;
        this.requestUpdate();
      });
  }

  getCardSize() {
    return 2;
  }

  getGridOptions() {
    return {
      rows: 2,
    };
  }

  protected shouldUpdate(changedProps: PropertyValues): boolean {
    if (!this._config) return false;
    if (changedProps.has("_config")) return true;
    if (changedProps.has("selectedDomain")) return true;
    if (changedProps.has("selectedDeviceClass")) return true;
    if (changedProps.has("selectedGroup")) return true;
    if (changedProps.has("selectedNativeGroup")) return true;
    if (changedProps.has("list_mode")) return true;
    if (changedProps.has("badge_mode")) return true;
    if (changedProps.has("_shouldHideCard")) return true;
    if (changedProps.has("__registryEntities")) return true;
    if (changedProps.has("__registryDevices")) return true;
    if (changedProps.has("__registryAreas")) return true;

    const oldHass = changedProps.get("hass") as HomeAssistant | undefined;
    if (!oldHass || !this.hass) return true;

    if (oldHass.themes !== this.hass.themes) return true;
    if (oldHass.localize !== this.hass.localize) return true;
    if (oldHass.language !== this.hass.language) return true;
    if (
      oldHass.entities !== this.hass.entities ||
      oldHass.devices !== this.hass.devices ||
      oldHass.areas !== this.hass.areas
    ) {
      this._invalidateNativeGroupDomainIndex();
      this._invalidateRegistryData();
      return true;
    }

    if (oldHass.states !== this.hass.states) {
      return this._hasRelevantHassStateChange(oldHass, this.hass);
    }

    return false;
  }

  private _hasRelevantHassStateChange(
    oldHass: HomeAssistant,
    newHass: HomeAssistant,
  ): boolean {
    if (this._hasTimeRelativeRules()) return true;

    const oldStates = oldHass.states || {};
    const newStates = newHass.states || {};
    const nativeGroups = this.getNativeGroupItems();
    if (nativeGroups.length > 0) {
      const domainsKey = this._nativeGroupDomainsKey(
        nativeGroups.flatMap((item) => nativeGroupSourceDomains(item.config)),
      );
      const cached = this._nativeGroupDomainIndexCache;
      if (cached.domainsKey !== domainsKey || cached.entities !== this.hass.entities) {
        return true;
      }
      for (const item of nativeGroups) {
        if (this._nativeGroupRelevantStateChanged(item.config, oldStates, newStates)) {
          return true;
        }
      }
    }

    const relevantIds = this._stableRelevantEntityIds();
    if (!relevantIds) return true;

    for (const entityId of relevantIds) {
      if (oldStates[entityId] !== newStates[entityId]) return true;
    }
    return false;
  }

  private _hasTimeRelativeRules(): boolean {
    const timeKeys = new Set(["last_changed", "last_updated", "last_triggered"]);
    const hasRelativeFilter = (filter: unknown): boolean => {
      if (!filter || typeof filter !== "object") return false;
      const { key, value } = filter as { key?: unknown; value?: unknown };
      return (
        typeof key === "string" &&
        timeKeys.has(key) &&
        typeof value === "string" &&
        /^([<>]=?)?\s*-?\d+(?:\.\d+)?(?:[mhd])?$/.test(value)
      );
    };

    return (this._config.rulesets || []).some((ruleset) => {
      if (Array.isArray(ruleset.filters)) {
        return ruleset.filters.some(hasRelativeFilter);
      }
      return [...timeKeys].some(
        (key) => (ruleset as Record<string, unknown>)[key] !== undefined,
      );
    });
  }

  private _stableRelevantEntityIds(): Set<string> | null {
    if (!this.hass) return null;
    const ids = new Set<string>();

    const extraEntities = this._config.extra_entities as string[] | undefined;
    extraEntities?.forEach((id) => ids.add(id));

    this.getPersonItems().forEach((entity) => ids.add(entity.entity_id));

    const domainItems = [...this.getDomainItems(), ...this.getDeviceClassItems()];
    if (domainItems.length) {
      const includedIds = this._computeIncludedIdsMemo(
        this.hass.entities || {},
        this.hass.devices || {},
        this.hass.areas || {},
        this._config?.area || null,
        this._config?.floor || null,
        this._config?.label || null,
        this.hiddenAreas,
        this.hiddenLabels,
        this.hiddenEntities,
      );
      includedIds.forEach((id) => ids.add(id));
    }

    const rulesets = this._config.rulesets || [];
    if (rulesets.length) {
      if (!this.__registryEntities.length) return null;
      const candidatesMap = this._computeGroupCandidatesMemo(
        rulesets,
        this.__registryEntities,
        this.__registryDevices,
        this.__registryAreas,
        this.hiddenEntities,
      );
      candidatesMap.forEach((candidates) => candidates.forEach((id) => ids.add(id)));
    }

    return ids;
  }

  private _nativeGroupDomainsKey(domains: Iterable<string>): string {
    return [...new Set(Array.from(domains))].sort().join("\u0000");
  }

  private _invalidateNativeGroupDomainIndex(): void {
    this._nativeGroupDomainIndexCache = {
      domainsKey: "",
      entities: undefined,
      index: new Map(),
    };
  }

  private _nativeGroupDomainIndex(domains: Iterable<string>): Map<string, string[]> {
    const domainSet = new Set(Array.from(domains));
    const domainsKey = this._nativeGroupDomainsKey(domainSet);
    const entities = this.hass?.entities;
    const cached = this._nativeGroupDomainIndexCache;
    if (cached.domainsKey === domainsKey && cached.entities === entities) {
      return cached.index;
    }

    const index = new Map<string, string[]>();
    const seen = new Set<string>();
    domainSet.forEach((domain) => index.set(domain, []));

    // Native groups discover registry-backed entity IDs from hass.entities.
    // Direct explicit state entities remain supported elsewhere, but native
    // groups intentionally do not scan hass.states for state-only additions;
    // new native-group IDs are picked up when hass.entities identity changes.
    const addId = (entityId: string) => {
      if (seen.has(entityId)) return;
      const domain = computeDomain(entityId);
      if (!domainSet.has(domain)) return;
      seen.add(entityId);
      index.get(domain)?.push(entityId);
    };

    Object.keys(entities || {}).forEach(addId);

    this._nativeGroupDomainIndexCache = { domainsKey, entities, index };
    return index;
  }

  private _configuredNativeGroupDomains(): string[] {
    return this.getNativeGroupItems().flatMap((item) =>
      nativeGroupSourceDomains(item.config),
    );
  }

  private _nativeGroupCandidateIds(config: LovelaceCardConfig): string[] {
    const domains = nativeGroupSourceDomains(config);
    const includes = nativeGroupEntityPatterns(config);
    const excludes = nativeGroupExcludePatterns(config);
    const index = this._nativeGroupDomainIndex(
      this._configuredNativeGroupDomains(),
    );
    const seen = new Set<string>();
    const ids: string[] = [];
    domains.forEach((domain) => {
      (index.get(domain) || []).forEach((entityId) => {
        if (seen.has(entityId)) return;
        seen.add(entityId);
        if (
          includes.length &&
          !includes.some((pattern) => matchNativeGroupPattern(entityId, pattern))
        ) {
          return;
        }
        if (excludes.some((pattern) => matchNativeGroupPattern(entityId, pattern))) {
          return;
        }
        ids.push(entityId);
      });
    });
    return ids;
  }

  private _nativeGroupStateCanAffect(
    config: LovelaceCardConfig,
    entity: HassEntity | undefined,
  ): boolean {
    if (!entity) return false;
    const domains = new Set(nativeGroupSourceDomains(config));
    if (!domains.has(computeDomain(entity.entity_id))) return false;
    const includes = nativeGroupEntityPatterns(config);
    if (
      includes.length &&
      !includes.some((pattern) => matchNativeGroupPattern(entity.entity_id, pattern))
    ) {
      return false;
    }
    if (
      nativeGroupExcludePatterns(config).some((pattern) =>
        matchNativeGroupPattern(entity.entity_id, pattern),
      )
    ) {
      return false;
    }
    return nativeGroupFilters(config).every((filter) =>
      nativeGroupMatchesFilter(entity, filter),
    );
  }

  private _nativeGroupRelevantStateChanged(
    config: LovelaceCardConfig,
    oldStates: HomeAssistant["states"],
    newStates: HomeAssistant["states"],
  ): boolean {
    for (const entityId of this._nativeGroupCandidateIds(config)) {
      if (oldStates[entityId] === newStates[entityId]) continue;
      if (
        this._nativeGroupStateCanAffect(config, oldStates[entityId]) ||
        this._nativeGroupStateCanAffect(config, newStates[entityId])
      ) {
        return true;
      }
    }
    return false;
  }

  private _processEntities(): void {
    const entitiesByDomain = this._entitiesByDomain();
    if (entitiesByDomain !== this.entitiesByDomain) {
      this.entitiesByDomain = entitiesByDomain;
    }
  }

  private _computeIncludedIdsMemo = memoizeOne(
    (
      entities: HomeAssistant["entities"] | undefined,
      devices: HomeAssistant["devices"] | undefined,
      areas: HomeAssistant["areas"] | undefined,
      area: LovelaceCardConfig["area"] | null,
      floor: LovelaceCardConfig["floor"] | null,
      label: LovelaceCardConfig["label"] | null,
      hiddenAreas: string[],
      hiddenLabels: string[],
      hiddenEntities: string[],
    ) =>
      getIncludedEntityIds(
        entities || {},
        devices || {},
        areas || {},
        {
          area,
          floor,
          label,
          hiddenAreas,
          hiddenLabels,
          hiddenEntities,
        },
        ALLOWED_DOMAINS,
      ),
  );

  private _mapIdsToStatesMemo = memoizeOne(
    (includedIds: string[], states: HomeAssistant["states"]) =>
      mapIdsToStates(includedIds, states),
    (newArgs, oldArgs) => {
      const [newIds, newStates] = newArgs;
      const [oldIds, oldStates] = oldArgs;

      if (newIds !== oldIds) return false;

      for (const id of newIds) {
        if (newStates[id] !== oldStates[id]) return false;
      }

      return true;
    },
  );

  private _customizationIndexMemo = memoizeOne(customizationIndex);

  private _computePersonIdsMemo = memoizeOne(getPersonEntityIds);

  private _mapPersonIdsToStatesMemo = memoizeOne(
    (ids: string[], states: HomeAssistant["states"]) =>
      mapPersonIdsToStates(ids, states),
    (newArgs, oldArgs) => {
      const [newIds, newStates] = newArgs;
      const [oldIds, oldStates] = oldArgs;

      if (newIds !== oldIds) return false;

      for (const id of newIds) {
        if (newStates[id] !== oldStates[id]) return false;
      }

      return true;
    },
  );

  private _computeExtraItemsMemo = memoizeOne(
    computeExtraItems,
    (newArgs, oldArgs) => {
      const [newCfg, newStates, newCustMap] = newArgs;
      const [oldCfg, oldStates, oldCustMap] = oldArgs;

      if (newCfg !== oldCfg || newCustMap !== oldCustMap) return false;

      const extraEntities = newCfg.extra_entities as string[] | undefined;
      if (!extraEntities) return true;

      for (const id of extraEntities) {
        if (newStates[id] !== oldStates[id]) return false;
      }

      return true;
    },
  );

  private _computeGroupItemsMemo = memoizeOne(computeGroupItems);
  private _computeNativeGroupItemsMemo = memoizeOne(
    (content: string[], nativeGroups?: LovelaceCardConfig[]) =>
      content
        .map((id, idx) => {
          const config = nativeGroups?.find(
            (group) => (group.group_id || group.id || group.name) === id,
          );
          if (!config || nativeGroupSourceDomains(config).length === 0) return undefined;
          return {
            type: "nativeGroup" as const,
            group_id: id,
            order: idx,
            config,
          };
        })
        .filter((item): item is {
          type: "nativeGroup";
          group_id: string;
          order: number;
          config: LovelaceCardConfig;
        } => !!item),
  );
  private _computeDomainItemsMemo = memoizeOne(computeDomainItems);
  private _computeDeviceClassItemsMemo = memoizeOne(computeDeviceClassItems);

  public _computeEntityMap = memoizeOne(
    (entities: EntityRegistryEntry[]) =>
      new Map(entities.map((e) => [e.entity_id, e])),
  );
  public _computeDeviceMap = memoizeOne(
    (devices: DeviceRegistryEntry[]) => new Map(devices.map((d) => [d.id, d])),
  );
  public _computeAreaMap = memoizeOne(
    (areas: AreaRegistryEntry[]) => new Map(areas.map((a) => [a.area_id, a])),
  );

  private _computeGroupCandidatesMemo = memoizeOne(
    (
      rulesets: Ruleset[],
      entities: EntityRegistryEntry[],
      devices: DeviceRegistryEntry[],
      areas: AreaRegistryEntry[],
      hiddenEntities: string[],
    ): Map<string, string[]> => {
      const map = new Map();
      const entityMap = this._computeEntityMap(entities);
      const deviceMap = this._computeDeviceMap(devices);
      const areaMap = this._computeAreaMap(areas);

      rulesets.forEach((rs) => {
        const candidates = filterStaticEntities(
          rs,
          entities,
          devices,
          areas,
          hiddenEntities,
          entityMap,
          deviceMap,
          areaMap,
        );
        map.set(rs.group_id, candidates);
      });
      return map;
    },
  );

  private _computeGroupResultsMemo = memoizeOne(
    (
      candidatesMap: Map<string, string[]>,
      states: HomeAssistant["states"],
      rulesets: Ruleset[],
      entities: EntityRegistryEntry[],
      devices: DeviceRegistryEntry[],
      areas: AreaRegistryEntry[],
    ): Map<string, HassEntity[]> => {
      const map = new Map();
      const fakeCard = {
        __registryEntities: entities,
        __registryDevices: devices,
        __registryAreas: areas,
        hass: { states },
      } as StatusCardLike;

      const entityMap = this._computeEntityMap(entities);
      const deviceMap = this._computeDeviceMap(devices);
      const areaMap = this._computeAreaMap(areas);

      rulesets.forEach((rs) => {
        const candidates = candidatesMap.get(rs.group_id) || [];
        const results = filterDynamicEntities(
          fakeCard,
          rs,
          candidates,
          states,
          entityMap,
          deviceMap,
          areaMap,
        );
        map.set(rs.group_id, results);
      });
      return map;
    },
  );

  private _entitiesByDomain(): { [domain: string]: HassEntity[] } {
    const entities = this.hass.entities || [];
    const devices = this.hass.devices || [];
    const areas = this.hass.areas || [];
    const states = this.hass?.states || {};

    const area = this._config?.area || null;
    const floor = this._config?.floor || null;
    const label = this._config?.label || null;
    const hiddenAreas = this.hiddenAreas;
    const hiddenLabels = this.hiddenLabels;
    const hiddenEntities = this.hiddenEntities;

    const includedIds = this._computeIncludedIdsMemo(
      entities,
      devices,
      areas,
      area,
      floor,
      label,
      hiddenAreas,
      hiddenLabels,
      hiddenEntities,
    );

    return this._mapIdsToStatesMemo(includedIds, states);
  }

  private _baseEntitiesMemo = memoizeOne(
    (all: HassEntity[], domain: string, deviceClass?: string): HassEntity[] => {
      return all.filter((entity) => {
        const st = entity.state;
        if (st === "unavailable" || st === "unknown") return false;
        const dc = entity.attributes.device_class;
        if (domain === "switch") {
          if (deviceClass === "outlet") return dc === "outlet";
          if (deviceClass === "switch")
            return dc === "switch" || dc === undefined;
          return true;
        }
        return !deviceClass || dc === deviceClass;
      });
    },
  );

  private _baseEntities(domain: string, deviceClass?: string): HassEntity[] {
    const all = this._entitiesByDomain()[domain] || [];
    return this._baseEntitiesMemo(all, domain, deviceClass);
  }

  public _totalEntities(domain: string, deviceClass?: string): HassEntity[] {
    return this._baseEntities(domain, deviceClass);
  }

  public _shouldShowTotalEntities(
    domain: string,
    deviceClass?: string,
  ): boolean {
    if (this._config.show_total_entities) return true;

    const key = typeKey(domain, deviceClass);
    const customization = this.getCustomizationForType(key);
    return customization?.show_total_entities === true;
  }
  public _shouldShowTotalNumbers(
    domain: string,
    deviceClass?: string,
  ): boolean {
    if (this._config.show_total_number) return true;

    const key = typeKey(domain, deviceClass);
    const customization = this.getCustomizationForType(key);
    return customization?.show_total_number === true;
  }

  private _shouldUseActiveBadgeCount(
    type: string,
    deviceClass?: string,
  ): boolean {
    return (
      this.getCustomizationForType(typeKey(type, deviceClass))
        ?.badge_active_count === true || this._config.badge_active_count === true
    );
  }

  private _activeBadgeEntities(entities: HassEntity[]): HassEntity[] {
    return entities.filter((entity) => {
      const domain = computeDomain(entity.entity_id);
      const deviceClass = entity.attributes?.device_class;
      const customization = this.getCustomizationForType(
        typeKey(domain, deviceClass),
      );
      return isEntityActive(
        entity,
        domain,
        deviceClass,
        customization?.invert === true,
      );
    });
  }

  public _isOn(domain: string, deviceClass?: string): HassEntity[] {
    const ents = this._baseEntities(domain, deviceClass);

    const key = typeKey(domain, deviceClass);
    const customization = this.getCustomizationForType(key);
    const isInverted = customization?.invert === true;

    return ents.filter((entity) =>
      isEntityActive(entity, domain, deviceClass, isInverted),
    );
  }

  public setConfig(config: LovelaceCardConfig): void {
    if (!config) {
      throw new Error("Invalid configuration.");
    }
    this._config = config;
    this.hide_person =
      config.hide_person !== undefined ? config.hide_person : false;
    this.hide_content_name =
      config.hide_content_name !== undefined ? config.hide_content_name : false;
    this.list_mode = config.list_mode !== undefined ? config.list_mode : false;
    this.badge_mode = !!config.badge_mode;
    this.no_background = !!config.no_background;
    this.badge_color = config.badge_color || "";
    this.badge_text_color = config.badge_text_color || "";
    this.hiddenEntities = config.hidden_entities || [];
    this.hiddenLabels = config.hidden_labels || [];
    this.hiddenAreas = config.hidden_areas || [];

    const styles = this._config.styles ?? {};

    this._parsedGlobalCardCss = parseCss(styles.card);
    this._parsedGlobalCss = parseCss(styles.button);
    this._parsedGlobalIconCss = parseCss(styles.icon);
    this._parsedGlobalNameCss = parseCss(styles.name);
    this._parsedGlobalStateCss = parseCss(styles.state);
  }

  private _showPopup(
    element: HTMLElement,
    dialogTag: string,
    dialogParams: StatusCardPopupDialogParams,
  ): void {
    element.dispatchEvent(
      new CustomEvent("show-dialog", {
        detail: {
          dialogTag,
          dialogImport: () => customElements.whenDefined(dialogTag),
          dialogParams,
          opener: element,
        },
        bubbles: true,
        composed: true,
      }),
    );
  }

  public computeLabel = memoizeOne(
    (schema: Schema, domain?: string, deviceClass?: string): string => {
      if (!this.hass || !schema) return schema?.name || "";
      return computeLabelCallback(this.hass, schema, domain, deviceClass);
    },
  );

  private _openNativeGroupPopup(index: number) {
    const item = this.getNativeGroupItems().find((entry) => entry.order === index);
    if (!item) return;
    const customization = this.getCustomizationForType(item.group_id);
    const allEntities = this._nativeGroupEntities(item.config);
    const activeEntities = this._activeBadgeEntities(allEntities);
    const showAll =
      this._config.show_total_entities === true ||
      item.config.show_total_entities === true ||
      customization?.show_total_entities === true;
    const popupEntitiesMode =
      customization?.popup_entities ?? item.config.popup_entities;
    const popupShowsAll =
      popupEntitiesMode === "all" ||
      (popupEntitiesMode !== "active" && showAll);

    this._showPopup(this, "status-card-popup", {
      title: customization?.name || item.config.name || item.group_id,
      hass: this.hass,
      entities: popupShowsAll ? allEntities : activeEntities,
      allEntities,
      selectedGroup: index,
      card: this,
      opener: this,
      content: allEntities.length
        ? undefined
        : (this.hass?.localize("ui.card.empty_state.no_entities") ??
          "No entities"),
      initialShowAll: popupShowsAll,
    });
  }

  private _openDomainPopup(domain: string | number) {
    let title = "Details";
    if (typeof domain === "string") {
      title =
        getCustomName(this._config, domain) ||
        this.computeLabel({ name: domain });
    } else if (typeof domain === "number" && this._config.content?.[domain]) {
      title = this._config.content[domain];
    }

    let entities: HassEntity[] = [];
    let allEntities: HassEntity[] = [];

    if (typeof domain === "number") {
      const groupId = this._config.content?.[domain];
      const ruleset = this._config.rulesets?.find(
        (g) => g.group_id === groupId,
      );
      if (ruleset) {
        const entityMap = this._computeEntityMap(this.__registryEntities);
        const deviceMap = this._computeDeviceMap(this.__registryDevices);
        const areaMap = this._computeAreaMap(this.__registryAreas);
        allEntities = filterEntitiesByRuleset(
          this,
          ruleset,
          entityMap,
          deviceMap,
          areaMap,
        );
        entities = allEntities;
      } else {
        entities = [];
        allEntities = [];
      }
    } else {
      const deviceClass = this.selectedDeviceClass || undefined;
      allEntities = this._totalEntities(domain, deviceClass);
      entities = this._shouldShowTotalEntities(domain, deviceClass)
        ? allEntities
        : this._isOn(domain, deviceClass);
    }

    const showAll =
      typeof domain === "string"
        ? this._shouldShowTotalEntities(
            domain,
            this.selectedDeviceClass || undefined,
          )
        : false;

    const dialogTag = "status-card-popup";
    this._showPopup(this, dialogTag, {
      title,
      hass: this.hass,
      entities,
      allEntities,
      selectedDomain: typeof domain === "string" ? domain : undefined,
      selectedDeviceClass: this.selectedDeviceClass || undefined,
      selectedGroup:
        this.selectedGroup !== null ? this.selectedGroup : undefined,
      card: this,
      opener: this,
      content: entities.length
        ? undefined
        : (this.hass?.localize("ui.card.empty_state.no_entities") ??
          "No entities"),
      initialShowAll: showAll,
    });
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    clearTimeout(this._resetDomainTimeout);
    clearTimeout(this._resetGroupTimeout);
    clearTimeout(this._resetNativeGroupTimeout);
  }

  protected willUpdate(changedProps: PropertyValues): void {
    super.willUpdate(changedProps);

    if (!this._config || !this.hass) return;

    if (
      changedProps.has("hass") ||
      changedProps.has("_config") ||
      changedProps.has("hiddenEntities") ||
      changedProps.has("hiddenLabels") ||
      changedProps.has("hiddenAreas")
    ) {
      this._processEntities();
      this._updateShouldHideCard();
    }
  }

  protected updated(changedProps: PropertyValues): void {
    super.updated(changedProps);

    if (!this._config || !this.hass) return;

    this._ensureRegistryData();

    const oldHass = changedProps.get("hass") as HomeAssistant | undefined;
    const oldConfig = changedProps.get("_config") as
      | LovelaceCardConfig
      | undefined;

    if (changedProps.has("selectedDomain") && this.selectedDomain) {
      const domain = this.selectedDomain;
      if (domain.includes(".")) {
        const entityId = domain;
        const stateObj = this.hass.states[entityId];
        if (stateObj) {
          this.showMoreInfo(stateObj);
        }
      } else {
        this._openDomainPopup(domain);
      }
      clearTimeout(this._resetDomainTimeout);
      this._resetDomainTimeout = setTimeout(() => {
        this.selectedDomain = null;
      }, 0);
    }

    if (changedProps.has("selectedGroup") && this.selectedGroup !== null) {
      const group = this.selectedGroup;
      this._openDomainPopup(group);
      clearTimeout(this._resetGroupTimeout);
      this._resetGroupTimeout = setTimeout(() => {
        this.selectedGroup = null;
      }, 0);
    }

    if (
      changedProps.has("selectedNativeGroup") &&
      this.selectedNativeGroup !== null
    ) {
      const group = this.selectedNativeGroup;
      this._openNativeGroupPopup(group);
      clearTimeout(this._resetNativeGroupTimeout);
      this._resetNativeGroupTimeout = setTimeout(() => {
        this.selectedNativeGroup = null;
      }, 0);
    }

    if (
      (changedProps.has("hass") &&
        (!oldHass || oldHass.themes !== this.hass.themes)) ||
      (changedProps.has("_config") &&
        (!oldConfig || oldConfig.theme !== this._config.theme))
    ) {
      applyThemesOnElement(
        this,
        this.hass.themes,
        this._config.theme,
        undefined,
        true,
      );
    }
  }

  private _handlePersonAction = (
    entity: HassEntity,
  ): ((ev: ActionHandlerEvent) => void) => {
    return (ev: ActionHandlerEvent) => {
      ev.stopPropagation();
      this.showMoreInfo(entity);
    };
  };

  private showMoreInfo(entity: HassEntity): void {
    const event = new CustomEvent("hass-more-info", {
      detail: { entityId: entity.entity_id },
      bubbles: true,
      composed: true,
    });
    this.dispatchEvent(event);
  }

  private _hasContent(): boolean {
    if (this.getPersonItems().length > 0) {
      return true;
    }

    const extra = this.getExtraItems();
    if (extra.length > 0) {
      const hasVisibleExtra = extra.some((item) => {
        const stateObj = this.hass?.states[item.panel];
        return (
          stateObj &&
          stateObj.state !== "unavailable" &&
          stateObj.state !== "unknown"
        );
      });
      if (hasVisibleExtra) return true;
    }

    const candidatesMap = this._computeGroupCandidatesMemo(
      this._config.rulesets || [],
      this.__registryEntities,
      this.__registryDevices,
      this.__registryAreas,
      this.hiddenEntities,
    );

    const allGroupEntities = this._computeGroupResultsMemo(
      candidatesMap,
      this.hass.states,
      this._config.rulesets || [],
      this.__registryEntities,
      this.__registryDevices,
      this.__registryAreas,
    );

    const hasGroupContent = this.getGroupItems().some((g) => {
      const entities = allGroupEntities.get(g.group_id) || [];
      return entities.length > 0;
    });
    if (hasGroupContent) {
      return true;
    }

    const domainAndDeviceClassItems = [
      ...this.getDomainItems(),
      ...this.getDeviceClassItems(),
    ];

    for (const item of domainAndDeviceClassItems) {
      const entities = this._baseEntities(
        item.domain,
        (item as DeviceClassItem).deviceClass,
      );
      if (entities.length === 0) continue;

      const key = (item as DeviceClassItem).deviceClass
        ? `${item.domain} - ${(item as DeviceClassItem).deviceClass}`
        : item.domain;
      const customization = this.getCustomizationForType(key);
      const showAll =
        this._config.show_total_entities ||
        customization?.show_total_entities === true;

      if (showAll) return true;

      const isInverted = customization?.invert === true;
      const active = entities.filter((entity) =>
        isEntityActive(
          entity,
          item.domain,
          (item as DeviceClassItem).deviceClass,
          isInverted,
        ),
      );
      if (active.length > 0) return true;
    }

    return false;
  }

  private _updateShouldHideCard(): void {
    if ((this._config.hide_card_if_empty ?? false) !== true) {
      this._shouldHideCard = false;
      this.hidden = false;
      return;
    }

    this._shouldHideCard = !this._hasContent();
    this.hidden = this._shouldHideCard;
  }

  private getPersonItems(): HassEntity[] {
    const ids = this._computePersonIdsMemo(
      this.hass.entities,
      this.hiddenEntities,
      this.hiddenLabels,
      this.hide_person,
    );
    return this._mapPersonIdsToStatesMemo(ids, this.hass.states);
  }

  public getExtraItems(): ExtraItem[] {
    if (!this._config || !this.hass) {
      return [];
    }
    return this._computeExtraItemsMemo(
      this._config,
      this.hass.states,
      this._customizationIndexMemo(this._config.customization),
    );
  }

  private getGroupItems(): GroupItem[] {
    return this._computeGroupItemsMemo(
      this._config.content || [],
      this._config.rulesets || [],
    );
  }

  private getNativeGroupItems() {
    return this._computeNativeGroupItemsMemo(
      this._config.content || [],
      this._config.native_groups || [],
    );
  }

  private _nativeGroupEntities(config: LovelaceCardConfig): HassEntity[] {
    return this._nativeGroupCandidateIds(config)
      .map((entityId) => this.hass?.states?.[entityId])
      .filter((entity): entity is HassEntity => {
        if (!entity) return false;
        return nativeGroupFilters(config).every((filter) =>
          nativeGroupMatchesFilter(entity, filter),
        );
      });
  }

  private getDomainItems(): DomainItem[] {
    return this._computeDomainItemsMemo(this._config.content || []);
  }

  private getDeviceClassItems(): DeviceClassItem[] {
    return this._computeDeviceClassItemsMemo(this._config.content || []);
  }
  public toggleDomain(domain?: string, deviceClass?: string): void {
    domain = domain ?? this.selectedDomain!;
    deviceClass = deviceClass ?? this.selectedDeviceClass!;
    const entities = this._isOn(domain, deviceClass);
    toggleDomain(this.hass, entities, domain, deviceClass);
  }

  private _handleDomainAction = memoizeOne(
    (
      domain: string,
      deviceClass?: string,
    ): ((ev: ActionHandlerEvent) => void) => {
      return (ev: ActionHandlerEvent) => {
        handleDomainAction(
          this,
          this.hass,
          this._config,
          domain,
          deviceClass,
          ev,
          {
            showMoreInfo: (entityId) => {
              const stateObj = this.hass.states[entityId];
              if (stateObj) this.showMoreInfo(stateObj);
            },
            toggleDomain: (d, dc) => this.toggleDomain(d, dc),
            selectDomain: (d, dc) => {
              this.selectedDomain = d;
              this.selectedDeviceClass = dc || null;
            },
          },
        );
      };
    },
  );

  private _handleGroupAction(
    groupId: string,
    index: number,
    entities: HassEntity[],
  ): (ev: ActionHandlerEvent) => void {
    return (ev: ActionHandlerEvent) => {
      handleDomainAction(
        this,
        this.hass,
        this._config,
        groupId,
        undefined,
        ev,
        {
          showMoreInfo: (entityId) => {
            const stateObj = this.hass.states[entityId];
            if (stateObj) this.showMoreInfo(stateObj);
          },
          toggleDomain: () => {
            entities.forEach((e) => {
              const domain = computeDomain(e.entity_id);
              toggleDomain(this.hass, [e], domain);
            });
          },
          selectDomain: () => {
            this.selectedGroup = index;
          },
        },
      );
    };
  }

  public getCustomizationForType(type: string): LovelaceCardConfig | undefined {
    return getCustomizationForType(
      this._config,
      type,
      this._customizationIndexMemo(this._config.customization),
    );
  }

  private _getIconStyles(
    type: "person" | "extra" | "domain" | "deviceClass",
    options: {
      color?: string;
      background_color?: string;
      square?: boolean;
      isNotHome?: boolean;
    } = {},
  ) {
    return getIconStyles(type, options);
  }

  private _computeActionHandler = memoizeOne(
    (hasHold: boolean, hasDoubleClick: boolean) => {
      return actionHandler({ hasHold, hasDoubleClick });
    },
  );

  private _computeBadgeStyles(customization?: LovelaceCardConfig) {
    const badgeColor =
      customization?.badge_color || this.badge_color || undefined;
    const badgeTextColor =
      customization?.badge_text_color || this.badge_text_color || undefined;
    const badgeStyles = {
      "--status-card-badge-color": badgeColor
        ? `var(--${badgeColor}-color)`
        : undefined,
      "--status-card-badge-text-color": badgeTextColor
        ? `var(--${badgeTextColor}-color)`
        : undefined,
    };
    return { badgeColor, badgeTextColor, badgeStyles };
  }

  private _computeButtonStyles(customization?: LovelaceCardConfig) {
    const itemStyles = getParsedCss(
      customization?.styles?.button || customization?.styles?.card,
      customization as { _parsedCss?: Record<string, string> },
    );
    return { ...this._parsedGlobalCss, ...itemStyles };
  }

  private _computeCustomIconStyles(customization?: LovelaceCardConfig) {
    const itemIconStyles =
      customization?._parsedIconCss || parseCss(customization?.styles?.icon);
    return { ...this._parsedGlobalIconCss, ...itemIconStyles };
  }

  private _computeTabStyles(
    customization?: LovelaceCardConfig,
    iconType: "domain" | "extra" = "domain",
    iconOpts?: { color?: string; background_color?: string },
  ) {
    const handler = undefined; // placeholder, set by caller
    const ah = this._computeActionHandler(
      hasAction(customization?.hold_action ?? this._config.hold_action),
      hasAction(
        customization?.double_tap_action ?? this._config.double_tap_action,
      ),
    );
    const contentClasses = {
      horizontal: this._config.content_layout === "horizontal",
    };
    const iconStyles = this._getIconStyles(iconType, {
      ...iconOpts,
      square: this._config.square,
    });
    const { badgeStyles } = this._computeBadgeStyles(customization);
    const buttonStyles = this._computeButtonStyles(customization);
    const customIconStyles = this._computeCustomIconStyles(customization);
    const showBadge = customization?.badge_mode ?? this.badge_mode;
    return {
      ah,
      contentClasses,
      iconStyles,
      badgeStyles,
      buttonStyles,
      customIconStyles,
      showBadge,
    };
  }

  private renderExtraTab(item: ExtraItem): TemplateResult {
    const { panel, icon, name, color, icon_css, background_color } = item;
    const stateObj = this.hass.states[panel];
    const customization = this.getCustomizationForType(panel);
    const handler = this._handleDomainAction(panel);
    const {
      ah,
      contentClasses,
      iconStyles,
      badgeStyles,
      buttonStyles,
      customIconStyles,
      showBadge,
    } = this._computeTabStyles(customization, "extra", {
      color,
      background_color,
    });
    const stateContent = customization?.state_content ?? "state";

    return html`
      <ha-tab-group-tab
        slot="nav"
        panel=${panel}
        @action=${handler}
        .actionHandler=${ah}
        class=${showBadge ? "badge-mode" : ""}
        style=${styleMap(badgeStyles)}
        data-badge=${ifDefined(showBadge ? "1" : undefined)}
      >
        <div
          class="extra-entity ${classMap(contentClasses)}"
          style=${styleMap(buttonStyles)}
        >
          <div
            class="entity-icon"
            style=${styleMap({ ...iconStyles, ...customIconStyles })}
          >
            ${icon.startsWith("/") || icon.startsWith("http")
              ? html`<img
                  src=${icon}
                  alt=${name}
                  style="border-radius:${this._config.square
                    ? "20%"
                    : "50%"};object-fit:cover;"
                />`
              : icon.startsWith("M")
                ? html`<ha-svg-icon
                    .path=${icon}
                    style="${icon_css || ""}"
                  ></ha-svg-icon>`
                : html`<ha-state-icon
                    .hass=${this.hass}
                    .stateObj=${stateObj}
                    .icon=${icon}
                    data-domain=${computeDomain(panel)}
                    data-state=${stateObj.state}
                    style="${icon_css || ""}"
                  ></ha-state-icon>`}
          </div>

          ${!showBadge
            ? html`<div class="entity-info">
                ${!this.hide_content_name
                  ? html`<div
                      class="entity-name"
                      style=${styleMap(this._parsedGlobalNameCss)}
                    >
                      ${name}
                    </div>`
                  : ""}
                <div
                  class="entity-state"
                  style=${styleMap(this._parsedGlobalStateCss)}
                >
                  <state-display
                    .stateObj=${stateObj}
                    .hass=${this.hass}
                    .content=${stateContent}
                    .name=${name}
                  ></state-display>
                </div>
              </div>`
            : ""}
        </div>
      </ha-tab-group-tab>
    `;
  }

  private renderGroupTab(ruleset: Ruleset, index: number): TemplateResult {
    const candidatesMap = this._computeGroupCandidatesMemo(
      this._config.rulesets || [],
      this.__registryEntities,
      this.__registryDevices,
      this.__registryAreas,
      this.hiddenEntities,
    );

    const allGroupEntities = this._computeGroupResultsMemo(
      candidatesMap,
      this.hass.states,
      this._config.rulesets || [],
      this.__registryEntities,
      this.__registryDevices,
      this.__registryAreas,
    );
    const entities = allGroupEntities.get(ruleset.group_id) || [];

    if (!entities.length) return html``;

    const groupId =
      ruleset.group_id ||
      `${this.hass!.localize("component.group.entity_component._.name")} ${
        index + 1
      }`;
    const groupIcon = ruleset.group_icon || mdiFormatListGroup;
    const color = getCustomColor(
      this._config,
      groupId,
      undefined,
      this._customizationIndexMemo(this._config.customization),
    );
    const background_color = getBackgroundColor(
      this._config,
      groupId,
      undefined,
      this._customizationIndexMemo(this._config.customization),
    );

    const customization = this.getCustomizationForType(groupId);

    const handler = this._handleGroupAction(groupId, index, entities);

    const {
      ah,
      contentClasses,
      iconStyles,
      badgeStyles,
      buttonStyles,
      customIconStyles,
      showBadge,
    } = this._computeTabStyles(customization, "domain", {
      color,
      background_color,
    });
    const badgeCount =
      customization?.badge_active_count === true ||
      this._config.badge_active_count === true
        ? this._activeBadgeEntities(entities).length
        : entities.length;

    return html`
      <ha-tab-group-tab
        slot="nav"
        panel=${"group-" + index}
        @action=${handler}
        .actionHandler=${ah}
        class=${showBadge ? "badge-mode" : ""}
        style=${styleMap(badgeStyles)}
        data-badge=${ifDefined(
          showBadge && entities.length > 0
            ? String(badgeCount)
            : undefined,
        )}
      >
        <div
          class="entity ${classMap(contentClasses)}"
          style=${styleMap(buttonStyles)}
        >
          <div
            class="entity-icon"
            style=${styleMap({ ...iconStyles, ...customIconStyles })}
          >
            ${groupIcon.startsWith("M")
              ? html`<ha-svg-icon .path=${groupIcon}></ha-svg-icon>`
              : html`<ha-icon icon=${groupIcon}></ha-icon>`}
          </div>
          ${!showBadge
            ? html`<div class="entity-info">
                ${!this.hide_content_name
                  ? html`<div
                      class="entity-name"
                      style=${styleMap(this._parsedGlobalNameCss)}
                    >
                      ${groupId}
                    </div>`
                  : ""}
                <div
                  class="entity-state"
                  style=${styleMap(this._parsedGlobalStateCss)}
                >
                  ${entities.length}
                  ${ruleset.group_status ? ` ${ruleset.group_status}` : ""}
                </div>
              </div>`
            : ""}
        </div>
      </ha-tab-group-tab>
    `;
  }

  private _handleNativeGroupAction(
    index: number,
  ): (ev: ActionHandlerEvent) => void {
    return (ev: ActionHandlerEvent) => {
      ev.stopPropagation();
      const action = ev.detail.action;
      const groupId = this._config.content?.[index];
      const customization = groupId
        ? this.getCustomizationForType(groupId)
        : undefined;
      const actionConfig = customization?.[`${action}_action`] ?? this._config?.[`${action}_action`];
      if (
        actionConfig === undefined ||
        actionConfig === "more-info" ||
        actionConfig?.action === "more-info"
      ) {
        this.selectedNativeGroup = index;
      }
    };
  }

  private renderNativeGroupTab(item: {
    type: "nativeGroup";
    group_id: string;
    order: number;
    config: LovelaceCardConfig;
  }): TemplateResult {
    const entities = this._nativeGroupEntities(item.config);
    const customization = this.getCustomizationForType(item.group_id);
    const showAll =
      this._config.show_total_entities === true ||
      item.config.show_total_entities === true ||
      customization?.show_total_entities === true;
    const active = this._activeBadgeEntities(entities);
    const visibleEntities = showAll ? entities : active;
    if (!visibleEntities.length) return html``;

    const groupIcon = customization?.icon || item.config.group_icon || item.config.icon || mdiFormatListGroup;
    const color = getCustomColor(
      this._config,
      item.group_id,
      undefined,
      this._customizationIndexMemo(this._config.customization),
    );
    const background_color = getBackgroundColor(
      this._config,
      item.group_id,
      undefined,
      this._customizationIndexMemo(this._config.customization),
    );
    const handler = this._handleNativeGroupAction(item.order);
    const {
      ah,
      contentClasses,
      iconStyles,
      badgeStyles,
      buttonStyles,
      customIconStyles,
      showBadge,
    } = this._computeTabStyles(customization, "domain", {
      color,
      background_color,
    });
    const badgeEntitiesMode =
      customization?.badge_entities ?? item.config.badge_entities;
    const badgeCount =
      badgeEntitiesMode === "active" ||
      customization?.badge_active_count === true ||
      item.config.badge_active_count === true ||
      this._config.badge_active_count === true
        ? active.length
        : badgeEntitiesMode === "all"
          ? entities.length
          : visibleEntities.length;
    const hideBadgeWhenZero =
      customization?.hide_badge_when_zero === true ||
      item.config.hide_badge_when_zero === true ||
      this._config.hide_badge_when_zero === true;
    const hideCountText =
      customization?.hide_count_text === true ||
      item.config.hide_count_text === true;
    const badgeValue =
      showBadge && visibleEntities.length > 0 && !(hideBadgeWhenZero && badgeCount === 0)
        ? String(badgeCount)
        : undefined;

    return html`
      <ha-tab-group-tab
        slot="nav"
        panel=${"native-group-" + item.order}
        @action=${handler}
        .actionHandler=${ah}
        class=${showBadge ? "badge-mode" : ""}
        style=${styleMap(badgeStyles)}
        data-badge=${ifDefined(badgeValue)}
      >
        <div
          class="entity ${classMap(contentClasses)}"
          style=${styleMap(buttonStyles)}
        >
          <div
            class="entity-icon"
            style=${styleMap({ ...iconStyles, ...customIconStyles })}
          >
            ${String(groupIcon).startsWith("M")
              ? html`<ha-svg-icon .path=${groupIcon}></ha-svg-icon>`
              : html`<ha-icon icon=${groupIcon}></ha-icon>`}
          </div>
          ${!showBadge && !hideCountText
            ? html`<div class="entity-info">
                ${!this.hide_content_name
                  ? html`<div
                      class="entity-name"
                      style=${styleMap(this._parsedGlobalNameCss)}
                    >
                      ${customization?.name || item.config.name || item.group_id}
                    </div>`
                  : ""}
                <div
                  class="entity-state"
                  style=${styleMap(this._parsedGlobalStateCss)}
                >
                  ${visibleEntities.length}
                </div>
              </div>`
            : ""}
        </div>
      </ha-tab-group-tab>
    `;
  }

  private renderItemTab(item: DomainItem | DeviceClassItem): TemplateResult {
    const domain = item.domain;
    const deviceClass = (item as DeviceClassItem).deviceClass;

    const active = this._isOn(domain, deviceClass);
    const total = this._totalEntities(domain, deviceClass);
    const showTotal = this._shouldShowTotalEntities(domain, deviceClass);
    const entities = showTotal ? total : active;
    if (!entities.length) return html``;

    const color = getCustomColor(
      this._config,
      domain,
      deviceClass,
      this._customizationIndexMemo(this._config.customization),
    );
    const customization = this.getCustomizationForType(
      typeKey(domain, deviceClass),
    );

    const handler = this._handleDomainAction(domain, deviceClass);
    const {
      ah,
      contentClasses,
      iconStyles,
      badgeStyles,
      buttonStyles,
      customIconStyles,
      showBadge,
    } = this._computeTabStyles(customization, "domain", {
      color,
      background_color: getBackgroundColor(
        this._config,
        domain,
        deviceClass,
        this._customizationIndexMemo(this._config.customization),
      ),
    });

    const name =
      getCustomName(this._config, domain, deviceClass) ||
      this.computeLabel({ name: deviceClass || domain });
    const badgeCount = this._shouldUseActiveBadgeCount(domain, deviceClass)
      ? active.length
      : entities.length;

    let stateText;
    if (this._shouldShowTotalNumbers(domain, deviceClass)) {
      stateText = `${active.length}/${total.length} ${getStatusProperty(
        this.hass,
        this._config,
        domain,
        deviceClass,
      )}`;
    } else if (this._shouldShowTotalEntities(domain, deviceClass)) {
      stateText = `${total.length}`;
    } else {
      stateText = `${active.length} ${getStatusProperty(
        this.hass,
        this._config,
        domain,
        deviceClass,
      )}`;
    }

    return html`
      <ha-tab-group-tab
        slot="nav"
        panel=${deviceClass || domain}
        @action=${handler}
        .actionHandler=${ah}
        class=${showBadge ? "badge-mode" : ""}
        style=${styleMap(badgeStyles)}
        data-badge=${ifDefined(
          showBadge && entities.length > 0
            ? String(badgeCount)
            : undefined,
        )}
      >
        <div
          class="entity ${classMap(contentClasses)}"
          style=${styleMap(buttonStyles)}
        >
          <div
            class="entity-icon"
            style=${styleMap({ ...iconStyles, ...customIconStyles })}
          >
            ${(() => {
              const icon = getCustomIcon(this._config, domain, deviceClass);
              return icon.startsWith("M")
                ? html`<ha-svg-icon .path=${icon}></ha-svg-icon>`
                : html`<ha-icon icon=${icon}></ha-icon>`;
            })()}
          </div>
          ${!showBadge
            ? html`<div class="entity-info">
                ${!this.hide_content_name
                  ? html`<div
                      class="entity-name"
                      style=${styleMap(this._parsedGlobalNameCss)}
                    >
                      ${name}
                    </div>`
                  : ""}
                <div
                  class="entity-state"
                  style=${styleMap(this._parsedGlobalStateCss)}
                >
                  ${stateText}
                </div>
              </div>`
            : ""}
        </div>
      </ha-tab-group-tab>
    `;
  }

  private _computeSortedEntities = memoizeOne(
    (
      extra: ExtraItem[],
      group: GroupItem[],
      nativeGroup: Array<{
        type: "nativeGroup";
        group_id: string;
        order: number;
        config: LovelaceCardConfig;
      }>,
      domain: DomainItem[],
      deviceClass: DeviceClassItem[],
    ): Array<AnyItem | {
      type: "nativeGroup";
      group_id: string;
      order: number;
      config: LovelaceCardConfig;
    }> =>
      [...extra, ...group, ...nativeGroup, ...domain, ...deviceClass].sort(
        (a, b) => a.order - b.order,
      ),
  );

  protected renderTab(item: AnyItem | {
    type: "nativeGroup";
    group_id: string;
    order: number;
    config: LovelaceCardConfig;
  }): TemplateResult {
    switch (item.type) {
      case "extra":
        return this.renderExtraTab(item);

      case "group":
        return this.renderGroupTab(item.ruleset, item.order);
      case "nativeGroup":
        return this.renderNativeGroupTab(item);
      case "domain":
      case "deviceClass":
        return this.renderItemTab(item);
    }
  }

  protected render() {
    const extra = this.getExtraItems();
    const group = this.getGroupItems();
    const nativeGroup = this.getNativeGroupItems();
    const domain = this.getDomainItems();
    const deviceClass = this.getDeviceClassItems();

    const sorted = this._computeSortedEntities(
      extra,
      group,
      nativeGroup,
      domain,
      deviceClass,
    );

    const personEntities = this.getPersonItems();

    if (this._shouldHideCard) {
      return html``;
    }

    const noScroll = {
      "no-scroll": !!this._config.no_scroll,
      "badge-mode": this.badge_mode,
      "no-background": this.no_background,
    };
    return html`
      <ha-card
        class=${classMap(noScroll)}
        style=${styleMap(this._parsedGlobalCardCss)}
      >
        <ha-tab-group without-scroll-controls class=${classMap(noScroll)}>
          <ha-tab-group-tab style="display:none" active></ha-tab-group-tab>
          ${repeat(
            personEntities,
            (entity) => entity.entity_id,
            (entity) => {
              const entityState = this.hass!.states[entity.entity_id];
              const isNotHome = entityState?.state !== "home";
              const contentClasses = {
                horizontal: this._config.content_layout === "horizontal",
              };
              const iconStyles = {
                "border-radius": this._config?.square ? "20%" : "50%",
                filter: isNotHome ? "grayscale(100%)" : "none",
              };

              const personHomeColor = this._config.person_home_color;
              const personAwayColor = this._config.person_away_color;
              const personHomeIcon =
                this._config.person_home_icon || "mdi:home";
              const personAwayIcon =
                this._config.person_away_icon || "mdi:home-export-outline";

              const badgeColor = isNotHome
                ? personAwayColor || "red"
                : personHomeColor || "green";

              const badgeIcon = isNotHome ? personAwayIcon : personHomeIcon;

              return html`
                <ha-tab-group-tab
                  slot="nav"
                  @action=${this._handlePersonAction(entity)}
                  .actionHandler=${this._computeActionHandler(false, false)}
                  class=${this.badge_mode ? "badge-mode" : ""}
                >
                  ${this.badge_mode
                    ? html`<div
                        class="person-badge"
                        style=${styleMap({
                          "--status-card-badge-color": badgeColor
                            ? `var(--${badgeColor}-color)`
                            : undefined,
                          "--status-card-badge-text-color": this
                            .badge_text_color
                            ? `var(--${this.badge_text_color}-color)`
                            : undefined,
                        })}
                      >
                        ${badgeIcon.startsWith("M")
                          ? html`<ha-svg-icon .path=${badgeIcon}></ha-svg-icon>`
                          : html`<ha-icon icon=${badgeIcon}></ha-icon>`}
                      </div>`
                    : ""}
                  <div class="entity ${classMap(contentClasses)}">
                    <div class="entity-icon" style=${styleMap(iconStyles)}>
                      ${entity.attributes.entity_picture
                        ? html`<img
                            src=${entity.attributes.entity_picture}
                            alt=${entity.attributes.friendly_name ||
                            entity.entity_id}
                            style=${styleMap(iconStyles)}
                          />`
                        : entity.attributes.icon?.startsWith("M")
                          ? html`<ha-svg-icon
                              class="center"
                              .path=${entity.attributes.icon}
                              style=${styleMap(iconStyles)}
                            ></ha-svg-icon>`
                          : html`<ha-icon
                              class="center"
                              icon=${entity.attributes.icon || "mdi:account"}
                              style=${styleMap(iconStyles)}
                            ></ha-icon>`}
                    </div>
                    ${!this.badge_mode
                      ? html`<div class="entity-info">
                          ${!this.hide_content_name
                            ? html`<div class="entity-name">
                                ${entity.attributes.friendly_name?.split(
                                  " ",
                                )[0] || ""}
                              </div>`
                            : ""}
                          <div class="entity-state">
                            ${getStatusProperty(
                              this.hass!,
                              this._config,
                              "person",
                              undefined,
                              entityState?.state,
                            )}
                          </div>
                        </div>`
                      : ""}
                  </div>
                </ha-tab-group-tab>
              `;
            },
          )}
          ${repeat(
            sorted,
            (i) =>
              i.type === "extra"
                ? i.panel
                : i.type === "domain"
                  ? i.domain
                  : i.type === "deviceClass"
                    ? `${i.domain}-${i.deviceClass}`
                    : i.type === "group"
                      ? `group-${i.group_id}`
                      : i.type === "nativeGroup"
                        ? `native-group-${i.group_id}`
                        : "",
            (i) => this.renderTab(i),
          )}
        </ha-tab-group>
      </ha-card>
    `;
  }

  static get styles() {
    return [cardStyles];
  }

  static getConfigElement() {
    return document.createElement("status-card-editor");
  }

  static getStubConfig() {
    return {};
  }
}
