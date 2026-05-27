import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  it('renders the Strata review workspace', () => {
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);

    fixture.detectChanges();
    http.expectOne('http://localhost:3000/runs').flush({ data: [] });
    fixture.detectChanges();

    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Strata');
    expect(compiled.textContent).toContain('Clinical run review');
    http.verify();
  });

  it('loads summary, patients, and medication signals after selecting the first run', () => {
    const fixture = TestBed.createComponent(App);
    const http = TestBed.inject(HttpTestingController);

    fixture.detectChanges();
    http.expectOne('http://localhost:3000/runs').flush({
      data: [
        {
          run_id: 'tiny-smoke-podman',
          artifact_root: 'data/runs/tiny-smoke-podman',
          imported_at: '2026-05-22T00:00:00.000Z',
          patient_count: 3,
          fact_count: 59,
          action_count: 13,
        },
      ],
    });
    http.expectOne('http://localhost:3000/runs/tiny-smoke-podman/summary').flush({
      run_id: 'tiny-smoke-podman',
      totals: {
        patients: 3,
        care_gaps: 4,
        reference_facts: 59,
        expected_actions: 13,
      },
      cohorts: [],
      complexity: [],
      urgency: [],
      action_priority: [],
    });
    http
      .expectOne(
        (request) =>
          request.url === 'http://localhost:3000/runs/tiny-smoke-podman/patients' &&
          request.params.get('sort') === 'urgency',
      )
      .flush({ data: [], page: 1, page_size: 25, total: 0 });
    http
      .expectOne(
        'http://localhost:3000/runs/tiny-smoke-podman/medication-signals?page=1&pageSize=25',
      )
      .flush({ data: [], page: 1, page_size: 25, total: 0 });

    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('tiny-smoke-podman');
    http.verify();
  });
});
