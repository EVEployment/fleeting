import { ref, watch, type Ref } from 'vue';

export interface AlertRule {
  id: string;
  label: string;
  getValue: () => number;
  operator: 'lt' | 'gt';
  threshold: number;
  durationMs: number;
  cooldownMs: number;
  gateEngagement: boolean;
  enabled: Ref<boolean>;
}

export interface AlertState {
  active: Ref<boolean>;
  acknowledged: Ref<boolean>;
  lastTriggered: Ref<number | null>;
  acknowledge: () => void;
}

export function useAlertRule(
  rule: AlertRule,
  source: Ref<unknown>,
  dataAvailable: Ref<boolean>,
  engagementActive: Ref<boolean>,
): AlertState {
  const active        = ref(false);
  const acknowledged  = ref(false);
  const lastTriggered = ref<number | null>(null);

  let conditionSince: number | null = null;

  function conditionMet(value: number): boolean {
    return rule.operator === 'lt' ? value < rule.threshold : value > rule.threshold;
  }

  function evaluate() {
    if (!rule.enabled.value) {
      conditionSince = null;
      active.value   = false;
      return;
    }

    // Gate: no data — clear alert immediately on disconnect
    if (!dataAvailable.value) {
      conditionSince = null;
      active.value   = false;
      return;
    }

    // Gate: engagement not active (when rule requires it)
    if (rule.gateEngagement && !engagementActive.value) {
      conditionSince = null;
      active.value   = false;
      return;
    }

    const value = rule.getValue();
    const now   = Date.now();

    if (conditionMet(value)) {
      if (conditionSince === null) {
        conditionSince = now;
      }

      const elapsed = now - conditionSince;
      if (elapsed >= rule.durationMs) {
        // Check cooldown
        if (lastTriggered.value !== null && now - lastTriggered.value < rule.cooldownMs) {
          return;
        }
        active.value        = true;
        acknowledged.value  = false;
        lastTriggered.value = now;
      }
    } else {
      conditionSince = null;
      active.value   = false;
    }
  }

  // Re-evaluate on data source change
  watch(source, evaluate);
  // Also re-evaluate when gates change, so disconnects/disengage clear alerts immediately
  watch(dataAvailable, evaluate);
  watch(engagementActive, evaluate);

  function acknowledge() {
    acknowledged.value = true;
  }

  return { active, acknowledged, lastTriggered, acknowledge };
}
