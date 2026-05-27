import { CommonModule } from '@angular/common';
import { HttpClient, HttpParams } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

interface RunRow {
  run_id: string;
  artifact_root: string;
  imported_at: string;
  patient_count: number;
  fact_count: number;
  action_count: number;
}

interface CountRow {
  key: string;
  count: number;
}

interface RunSummary {
  run_id: string;
  totals: {
    patients: number;
    care_gaps: number;
    reference_facts: number;
    expected_actions: number;
  };
  cohorts: CountRow[];
  complexity: CountRow[];
  urgency: CountRow[];
  action_priority: CountRow[];
}

interface PatientRow {
  patient_id: string;
  primary_cohort: string;
  all_cohorts: string[];
  age: number | null;
  age_band: string;
  sex: string;
  race: string;
  ethnicity: string;
  payer: string;
  geography: string;
  complexity: string;
  urgency: string;
  care_gap_count: number;
  reference_fact_count: number;
  expected_action_count: number;
}

interface PagedResponse<T> {
  data: T[];
  page: number;
  page_size: number;
  total: number;
}

interface MedicationSignal {
  patient_id: string;
  fact_id: string;
  class: string;
  medication_key?: string;
  medication_display: string;
  current_probability: string;
  latest_date: string | null;
  latest_source_id: string;
  source_ids?: string[];
  raw?: unknown;
}

interface PatientDetail {
  patient: PatientRow & { patient_raw?: unknown };
  facts: Array<{
    fact_id: string;
    category: string;
    kind: string;
    priority: string;
    use_for_actions: boolean;
    source_ids: string[];
    text: string;
    raw?: unknown;
  }>;
  actions: Array<{
    action_id: string;
    category: string;
    priority: string;
    supporting_fact_ids: string[];
    supporting_evidence_ids: string[];
    text: string;
    raw?: unknown;
  }>;
  cases: Array<{
    case_id: string;
    primary_cohort: string;
    cohorts: string[];
    raw?: unknown;
  }>;
  medications: MedicationSignal[];
}

interface ResolvedEvidence {
  reference: string;
  resource: unknown | null;
}

interface ComplexityComponent {
  name: string;
  value: number;
  points: number;
  source_fact_ids: string[];
}

interface ComplexityBreakdown {
  score: number;
  bucket: string;
  urgency: string;
  scoring: string;
  social_note?: string;
  components: ComplexityComponent[];
}

interface RuleRow {
  name: string;
  rule: string;
  notes?: string;
}

type ViewMode = 'summary' | 'patients' | 'medications' | 'rules';

@Component({
  selector: 'app-root',
  imports: [CommonModule, FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.scss',
})
export class App {
  private readonly http = inject(HttpClient);
  private readonly apiBase = 'http://localhost:3000';

  readonly runs = signal<RunRow[]>([]);
  readonly selectedRunId = signal('');
  readonly summary = signal<RunSummary | null>(null);
  readonly patients = signal<PatientRow[]>([]);
  readonly patientTotal = signal(0);
  readonly medicationSignals = signal<MedicationSignal[]>([]);
  readonly medicationTotal = signal(0);
  readonly selectedPatient = signal<PatientDetail | null>(null);
  readonly loading = signal(false);
  readonly error = signal('');
  readonly mode = signal<ViewMode>('summary');

  patientPage = 1;
  patientPageSize = 25;
  patientSort = 'urgency';
  patientDirection = 'desc';
  cohortFilter = '';
  complexityFilter = '';
  urgencyFilter = '';

  medicationPage = 1;
  medicationPageSize = 25;
  medicationClassFilter = '';

  readonly cohortRules: RuleRow[] = [
    {
      name: 'type2_diabetes',
      rule: 'Evidence of type 2 diabetes diagnosis, diabetes-range labs, diabetes control facts, or diabetes medication patterns.',
    },
    {
      name: 'prediabetes',
      rule: 'Prediabetes-range A1c/glucose evidence without stronger type 2 diabetes classification.',
    },
    {
      name: 'cardiometabolic',
      rule: 'Cardiometabolic risk evidence such as hypertension, dyslipidemia, CAD, CKD, obesity, abnormal cardiometabolic labs, or related medication signals.',
    },
    {
      name: 'controls',
      rule: 'Patients without the stronger disease/risk cohort signals used by the configured cohort rules.',
    },
    {
      name: 'near_misses',
      rule: 'Patients close to cohort thresholds or with partial evidence that should be reviewed separately from clear positives.',
    },
  ];

  readonly complexityRules: RuleRow[] = [
    {
      name: 'Chronic conditions',
      rule: '2 points per condition group, capped at 10 points.',
      notes: 'Includes diabetes, hypertension, CKD, CAD, obesity, and dyslipidemia control/diagnosis signals.',
    },
    {
      name: 'Active medication classes',
      rule: '1 point per current high-probability medication class, capped at 8 points.',
    },
    {
      name: 'Abnormal labs',
      rule: '1 point per abnormal observation trend, capped at 8 points.',
      notes: 'Only trends with latest_at within 3 years of the patient/run reference date count toward complexity and urgency.',
    },
    {
      name: 'Care gaps',
      rule: '2 points per care gap, capped at 10 points.',
    },
    {
      name: 'ED visits',
      rule: '2 points per ED visit in the last 90 days, capped at 6 points.',
      notes: 'The source encounter date must also be within the 3-year clinical relevance lookback.',
    },
    {
      name: 'Admissions',
      rule: '3 points per inpatient admission in the last 180 days, capped at 9 points.',
      notes: 'The source encounter date must also be within the 3-year clinical relevance lookback.',
    },
    {
      name: 'Social/access flags',
      rule: '1 point per social/access flag, capped at 4 points.',
    },
  ];

  readonly trendHorizonRules: RuleRow[] = [
    {
      name: 'active_short_term',
      rule: '6 or more values in the last 90 days.',
      notes: 'Active clinical trend. Can drive current-state classification and trend-driven actions.',
    },
    {
      name: 'medium_clinical_course',
      rule: '4 or more values in the last 365 days.',
      notes: 'Recent clinical course. Can drive current-state classification and trend-driven actions.',
    },
    {
      name: 'longitudinal_drift',
      rule: '3 or more values over the last 10 years with latest evidence still within the 3-year relevance lookback.',
      notes: 'Contextual trend. Recent latest value may support current state, but the trend does not independently classify the patient as actively worsening.',
    },
    {
      name: 'historical_drift',
      rule: '3 or more values where latest evidence is outside the 3-year clinical relevance lookback.',
      notes: 'Historical context only.',
    },
    {
      name: 'sparse_weak',
      rule: 'Too few or too spread-out values to infer a reliable active trend.',
      notes: 'Recent latest value may support current state, but the sparse trend is insufficient for action triggers.',
    },
  ];

  readonly complexityBuckets: RuleRow[] = [
    { name: 'low', rule: 'score 0-4' },
    { name: 'moderate', rule: 'score 5-11' },
    { name: 'high', rule: 'score 12-19' },
    { name: 'very_high', rule: 'score 20+' },
  ];

  readonly urgencyRules: RuleRow[] = [
    {
      name: 'urgent',
      rule: 'Urgent care gap, inpatient use in 30 days, or at least 2 ED visits in 90 days.',
      notes: 'Time-based utilization triggers require source encounters within the 3-year clinical relevance lookback.',
    },
    {
      name: 'high',
      rule: 'Important care gap, inpatient use in 180 days, or at least 2 recent abnormal labs.',
      notes: 'Abnormal labs and utilization events must pass the 3-year clinical relevance lookback.',
    },
    {
      name: 'routine',
      rule: 'Any care gap or at least 1 recent abnormal lab.',
    },
    {
      name: 'low',
      rule: 'No routine, high, or urgent triggers present.',
    },
  ];

  readonly activeRun = computed(() =>
    this.runs().find((run) => run.run_id === this.selectedRunId()),
  );

  readonly totalPatientPages = computed(() =>
    Math.max(1, Math.ceil(this.patientTotal() / this.patientPageSize)),
  );

  readonly totalMedicationPages = computed(() =>
    Math.max(1, Math.ceil(this.medicationTotal() / this.medicationPageSize)),
  );

  readonly selectedPatientId = computed(() => this.selectedPatient()?.patient.patient_id ?? '');

  ngOnInit() {
    this.loadRuns();
  }

  loadRuns() {
    this.withLoading(() => {
      this.http.get<{ data: RunRow[] }>(`${this.apiBase}/runs`).subscribe({
        next: (response) => {
          this.runs.set(response.data);
          const firstRun = response.data[0]?.run_id ?? '';
          if (firstRun) {
            this.selectRun(firstRun);
          }
        },
        error: () => this.setError('Unable to load runs from the API.'),
      });
    });
  }

  selectRun(runId: string) {
    if (!runId) {
      return;
    }
    this.selectedRunId.set(runId);
    this.selectedPatient.set(null);
    this.patientPage = 1;
    this.medicationPage = 1;
    this.loadSummary();
    this.loadPatients();
    this.loadMedicationSignals();
  }

  setMode(mode: ViewMode) {
    this.mode.set(mode);
  }

  loadSummary() {
    const runId = this.selectedRunId();
    if (!runId) {
      return;
    }
    this.http.get<RunSummary>(`${this.apiBase}/runs/${runId}/summary`).subscribe({
      next: (summary) => this.summary.set(summary),
      error: () => this.setError('Unable to load the run summary.'),
    });
  }

  loadPatients() {
    const runId = this.selectedRunId();
    if (!runId) {
      return;
    }
    const params = new HttpParams()
      .set('page', this.patientPage)
      .set('pageSize', this.patientPageSize)
      .set('sort', this.patientSort)
      .set('direction', this.patientDirection);
    const filtered = this.appendOptionalFilters(params, {
      cohort: this.cohortFilter,
      complexity: this.complexityFilter,
      urgency: this.urgencyFilter,
    });

    this.http
      .get<PagedResponse<PatientRow>>(`${this.apiBase}/runs/${runId}/patients`, {
        params: filtered,
      })
      .subscribe({
        next: (response) => {
          this.patients.set(response.data);
          this.patientTotal.set(response.total);
        },
        error: () => this.setError('Unable to load patients.'),
      });
  }

  loadMedicationSignals() {
    const runId = this.selectedRunId();
    if (!runId) {
      return;
    }
    let params = new HttpParams()
      .set('page', this.medicationPage)
      .set('pageSize', this.medicationPageSize);
    if (this.medicationClassFilter) {
      params = params.set('class', this.medicationClassFilter);
    }

    this.http
      .get<
        PagedResponse<MedicationSignal>
      >(`${this.apiBase}/runs/${runId}/medication-signals`, { params })
      .subscribe({
        next: (response) => {
          this.medicationSignals.set(response.data);
          this.medicationTotal.set(response.total);
        },
        error: () => this.setError('Unable to load medication signals.'),
      });
  }

  loadPatient(patientId: string) {
    const runId = this.selectedRunId();
    if (!runId) {
      return;
    }
    this.http.get<PatientDetail>(`${this.apiBase}/runs/${runId}/patients/${patientId}`).subscribe({
      next: (detail) => {
        this.selectedPatient.set(detail);
        this.mode.set('patients');
      },
      error: () => this.setError('Unable to load patient drilldown.'),
    });
  }

  applyPatientFilters() {
    this.patientPage = 1;
    this.loadPatients();
  }

  applyMedicationFilters() {
    this.medicationPage = 1;
    this.loadMedicationSignals();
  }

  nextPatientPage() {
    if (this.patientPage < this.totalPatientPages()) {
      this.patientPage += 1;
      this.loadPatients();
    }
  }

  previousPatientPage() {
    if (this.patientPage > 1) {
      this.patientPage -= 1;
      this.loadPatients();
    }
  }

  nextMedicationPage() {
    if (this.medicationPage < this.totalMedicationPages()) {
      this.medicationPage += 1;
      this.loadMedicationSignals();
    }
  }

  previousMedicationPage() {
    if (this.medicationPage > 1) {
      this.medicationPage -= 1;
      this.loadMedicationSignals();
    }
  }

  badgeClass(value: string | null | undefined) {
    return `badge ${normalizeToken(value)}`;
  }

  formatJson(value: unknown) {
    return JSON.stringify(value ?? null, null, 2);
  }

  joinValues(values: string[] | null | undefined) {
    return values?.length ? values.join(', ') : 'none';
  }

  resolveSupportingEvidence(detail: PatientDetail, evidenceIds: string[] | null | undefined) {
    const index = this.buildResourceIndex(detail.patient.patient_raw);
    return (evidenceIds ?? []).map((reference) => ({
      reference,
      resource: index.get(reference) ?? index.get(reference.split('/').pop() ?? '') ?? null,
    }));
  }

  evidenceSummary(evidence: ResolvedEvidence) {
    if (!isRecord(evidence.resource)) {
      return evidence.reference;
    }

    const resourceType = textValue(evidence.resource['resourceType']);
    const id = textValue(evidence.resource['id']);
    const display = firstCodingDisplay(evidence.resource);
    const date =
      textValue(evidence.resource['effectiveDateTime']) ||
      textValue(evidence.resource['authoredOn']) ||
      textValue(evidence.resource['performedDateTime']) ||
      periodSummary(evidence.resource['period']);
    const value = quantitySummary(evidence.resource['valueQuantity']);

    return [resourceType, id, display, value, date].filter(Boolean).join(' · ');
  }

  complexityBreakdown(detail: PatientDetail) {
    const summaryFact = detail.facts.find((fact) => fact.fact_id === 'patient_complexity_summary');
    const raw = isRecord(summaryFact?.raw) ? summaryFact.raw : {};
    const complexity = isRecord(raw['complexity']) ? raw['complexity'] : {};
    const components = Array.isArray(complexity['components'])
      ? complexity['components'].filter(isRecord).map((component) => ({
          name: textValue(component['name']),
          value: numberValue(component['value']),
          points: numberValue(component['points']),
          source_fact_ids: stringList(component['source_fact_ids']),
        }))
      : [];

    if (!summaryFact && components.length === 0) {
      return null;
    }

    return {
      score: numberValue(complexity['score']),
      bucket: textValue(complexity['bucket']) || detail.patient.complexity,
      urgency: textValue(complexity['urgency']) || detail.patient.urgency,
      scoring: textValue(complexity['scoring']) || 'simple_additive_v1',
      social_note: textValue(complexity['social_note']),
      components,
    };
  }

  componentLabel(name: string) {
    const labels: Record<string, string> = {
      chronic_condition_count: 'Chronic conditions',
      active_medication_class_count: 'Active medication classes',
      abnormal_lab_count: 'Abnormal labs',
      care_gap_count: 'Care gaps',
      recent_ed_visits_90d: 'ED visits in 90 days',
      recent_admissions_180d: 'Admissions in 180 days',
      social_access_flag_count: 'Social/access flags',
    };
    return labels[name] ?? name.replace(/_/g, ' ');
  }

  complexityBucketRule(bucket: string) {
    const rules: Record<string, string> = {
      low: 'score 0-4',
      moderate: 'score 5-11',
      high: 'score 12-19',
      very_high: 'score 20+',
    };
    return rules[bucket] ?? 'no bucket rule available';
  }

  urgencyRule(urgency: string) {
    const rules: Record<string, string> = {
      urgent:
        'urgent care gap, inpatient use in 30 days, or at least 2 ED visits in 90 days',
      high: 'important care gap, inpatient use in 180 days, or at least 2 abnormal labs',
      routine: 'any care gap or abnormal lab signal',
      low: 'none of the routine, high, or urgent triggers were present',
    };
    return rules[urgency] ?? 'no urgency rule available';
  }

  sourceFacts(detail: PatientDetail, sourceFactIds: string[] | null | undefined) {
    const ids = sourceFactIds ?? [];
    return ids.map((factId) => ({
      factId,
      fact: detail.facts.find((fact) => fact.fact_id === factId) ?? null,
    }));
  }

  private appendOptionalFilters(params: HttpParams, filters: Record<string, string>) {
    let next = params;
    for (const [key, value] of Object.entries(filters)) {
      if (value) {
        next = next.set(key, value);
      }
    }
    return next;
  }

  private withLoading(work: () => void) {
    this.loading.set(true);
    this.error.set('');
    work();
    this.loading.set(false);
  }

  private setError(message: string) {
    this.error.set(message);
    this.loading.set(false);
  }

  private buildResourceIndex(patientRaw: unknown) {
    const index = new Map<string, unknown>();
    if (!isRecord(patientRaw) || !isRecord(patientRaw['resources'])) {
      return index;
    }

    for (const [resourceType, value] of Object.entries(patientRaw['resources'])) {
      const resources = Array.isArray(value) ? value : value ? [value] : [];
      for (const resource of resources) {
        if (!isRecord(resource)) {
          continue;
        }
        const id = textValue(resource['id']);
        if (!id) {
          continue;
        }
        index.set(id, resource);
        index.set(`${resourceType}/${id}`, resource);
        const explicitType = textValue(resource['resourceType']);
        if (explicitType) {
          index.set(`${explicitType}/${id}`, resource);
        }
      }
    }

    return index;
  }
}

function normalizeToken(value: string | null | undefined) {
  return (value ?? 'unknown').replace(/[^a-z0-9_-]/gi, '_').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function textValue(value: unknown) {
  return typeof value === 'string' ? value : '';
}

function numberValue(value: unknown) {
  return typeof value === 'number' ? value : Number(value) || 0;
}

function stringList(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function firstCodingDisplay(resource: Record<string, unknown>) {
  for (const field of ['code', 'medicationCodeableConcept', 'type']) {
    const value = resource[field];
    if (!isRecord(value) || !Array.isArray(value['coding'])) {
      continue;
    }
    const coding = value['coding'].find(isRecord);
    const display = coding ? textValue(coding['display']) || textValue(coding['code']) : '';
    if (display) {
      return display;
    }
  }
  return '';
}

function quantitySummary(value: unknown) {
  if (!isRecord(value)) {
    return '';
  }
  const rawValue = value['value'];
  const numberValue = typeof rawValue === 'number' || typeof rawValue === 'string' ? rawValue : '';
  const unit = textValue(value['unit']) || textValue(value['code']);
  return [numberValue, unit].filter(Boolean).join(' ');
}

function periodSummary(value: unknown) {
  if (!isRecord(value)) {
    return '';
  }
  const start = textValue(value['start']);
  const end = textValue(value['end']);
  return start && end ? `${start} to ${end}` : start || end;
}
