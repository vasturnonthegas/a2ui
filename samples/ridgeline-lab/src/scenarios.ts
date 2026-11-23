/**
 * Synthetic demo scenarios for the Ridgeline lab.
 *
 * Every record, name, ID, and date here is invented for local demos. Stub payloads use only
 * the v1.0 Basic catalog, and each stub's root is reachable from the `root` component id.
 * The record shapes loosely follow Ridgeline's RFI, punch item, and daily log DTOs, the
 * Cortex decision record (statement, rationale, decider, date, citations), and LocalFlow
 * meeting notes (owner and due date per action item).
 */

export interface Scenario {
  id: string;
  title: string;
  product: 'Ridgeline' | 'Cortex' | 'LocalFlow';
  description: string;
  prompt: string;
  fixture: Record<string, unknown>;
  facts: Record<string, string>;
  rubric: {id: string; task: string; questions: Record<string, string>};
  stub: {messages: unknown[]; markdown: string};
  mobile?: boolean;
}

const PROTOCOL_VERSION = '1.0';
const BASIC_CATALOG_ID = 'https://a2ui.org/specification/v1_0/catalogs/basic/catalog.json';
const AS_OF_DATE = '2026-11-23';

type Component = Record<string, unknown> & {id: string; component: string};

function text(id: string, value: string, variant?: 'caption' | 'body'): Component {
  return variant
    ? {id, component: 'Text', text: value, variant}
    : {id, component: 'Text', text: value};
}

function column(id: string, children: string[]): Component {
  return {id, component: 'Column', children};
}

function row(id: string, children: string[]): Component {
  return {id, component: 'Row', children, justify: 'spaceBetween', align: 'center'};
}

function card(id: string, child: string): Component {
  return {id, component: 'Card', child};
}

function divider(id: string): Component {
  return {id, component: 'Divider'};
}

function createSurface(
  surfaceId: string,
  components: Component[],
  dataModel?: Record<string, unknown>,
): unknown {
  return {
    version: PROTOCOL_VERSION,
    createSurface: {
      surfaceId,
      catalogId: BASIC_CATALOG_ID,
      ...(dataModel ? {dataModel} : {}),
      components,
    },
  };
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    value.forEach(deepFreeze);
  } else if (typeof value === 'object' && value !== null) {
    Object.values(value).forEach(deepFreeze);
  }
  return Object.freeze(value);
}

// ---------------------------------------------------------------------------
// Shared synthetic Ridgeline project
// ---------------------------------------------------------------------------

const PROJECT = {
  id: 'PRJ-2417',
  name: 'Aspen Hollow Lot 12',
  address: '4180 Larkspur Trail',
  city: 'Bozeman',
  state: 'MT',
  status: 'active',
  startDate: '2026-06-08',
  targetCompletionDate: '2027-04-16',
  superintendent: 'Dana Whitfield',
} as const;

// ---------------------------------------------------------------------------
// 1. Ridgeline RFI triage
// ---------------------------------------------------------------------------

const rfiFixture = {
  asOfDate: AS_OF_DATE,
  project: PROJECT,
  rfis: [
    {
      id: 'RFI-031',
      number: 31,
      subject: 'Header size at garage door opening',
      question:
        'Plans call out a 4x12 header at the 16 ft garage opening; framer asks whether an LVL is required.',
      answer: null,
      status: 'open',
      assignedTradeName: 'Summit Framing',
      dueDate: '2026-11-18',
      createdAt: '2026-11-10T16:05:00Z',
    },
    {
      id: 'RFI-034',
      number: 34,
      subject: 'Shower niche waterproofing detail',
      question: 'Confirm membrane product and whether the niche sill needs a slope to drain.',
      answer: null,
      status: 'open',
      assignedTradeName: 'Gallatin Tile Co.',
      dueDate: '2026-11-20',
      createdAt: '2026-11-13T18:40:00Z',
    },
    {
      id: 'RFI-036',
      number: 36,
      subject: 'Kitchen island outlet location',
      question:
        'Owner wants the island outlet on the seating side; confirm code clearance from the sink.',
      answer: null,
      status: 'open',
      assignedTradeName: 'Bridger Electric',
      dueDate: '2026-11-25',
      createdAt: '2026-11-18T15:12:00Z',
    },
    {
      id: 'RFI-037',
      number: 37,
      subject: 'Exterior stone veneer return depth',
      question: 'Should the stone veneer return 24 in or 36 in around the front porch corners?',
      answer: null,
      status: 'open',
      assignedTradeName: 'Madison Masonry',
      dueDate: '2026-11-30',
      createdAt: '2026-11-20T17:30:00Z',
    },
    {
      id: 'RFI-029',
      number: 29,
      subject: 'Basement egress window well size',
      question: 'Confirm minimum window well projection for the bedroom egress window.',
      answer: 'Use a 36 in projection well with a permanent ladder per the structural sheet S-2.',
      status: 'closed',
      assignedTradeName: 'Summit Framing',
      dueDate: '2026-11-14',
      answeredAt: '2026-11-13T21:00:00Z',
      createdAt: '2026-11-06T14:20:00Z',
    },
  ],
};

const rfiTriage: Scenario = {
  id: 'rfi-triage',
  title: 'RFI triage',
  product: 'Ridgeline',
  description:
    'Sort project RFIs into overdue, due soon, and recently closed so the superintendent knows what to chase.',
  prompt:
    'Triage the RFIs for Aspen Hollow Lot 12 as of 2026-11-23. Group them into overdue (open and past due), upcoming (open and due within 7 days), and closed. For each RFI show its ID, subject, assigned trade, and due date.',
  fixture: rfiFixture,
  facts: {
    asOfDate: '2026-11-23',
    project: 'Aspen Hollow Lot 12',
    overdue1Id: 'RFI-031',
    overdue1Subject: 'Header size at garage door opening',
    overdue1Due: '2026-11-18',
    overdue2Id: 'RFI-034',
    overdue2Subject: 'Shower niche waterproofing detail',
    overdue2Due: '2026-11-20',
    upcoming1Id: 'RFI-036',
    upcoming1Due: '2026-11-25',
    upcoming2Id: 'RFI-037',
    upcoming2Due: '2026-11-30',
    closedId: 'RFI-029',
    closedSubject: 'Basement egress window well size',
    closedDue: '2026-11-14',
  },
  rubric: {
    id: 'ridgeline-rfi-triage-v1',
    task: 'Triage Aspen Hollow Lot 12 RFIs as of 2026-11-23 into overdue, upcoming, and closed groups.',
    questions: {
      overdue031: 'Does the output identify RFI-031 as overdue?',
      overdue034: 'Does the output identify RFI-034 as overdue?',
      upcoming036: 'Does the output identify RFI-036 as upcoming rather than overdue?',
      upcoming037: 'Does the output identify RFI-037 as upcoming rather than overdue?',
      closed029: 'Does the output identify RFI-029 as closed?',
      dueDates: 'Does the output give a due date for every open RFI it lists?',
      noInvented:
        'Is every RFI ID in the output one of RFI-029, RFI-031, RFI-034, RFI-036, or RFI-037?',
    },
  },
  stub: {
    messages: [
      createSurface('rfi-triage', [
        column('root', ['heading', 'asOf', 'overdueCard', 'upcomingCard', 'closedCard']),
        text('heading', '## RFI triage: Aspen Hollow Lot 12'),
        text('asOf', 'As of 2026-11-23', 'caption'),
        card('overdueCard', 'overdueCol'),
        column('overdueCol', ['overdueTitle', 'rfi031', 'rfi034']),
        text('overdueTitle', '### Overdue (2)'),
        text(
          'rfi031',
          '**RFI-031** Header size at garage door opening. Summit Framing, due 2026-11-18',
        ),
        text(
          'rfi034',
          '**RFI-034** Shower niche waterproofing detail. Gallatin Tile Co., due 2026-11-20',
        ),
        card('upcomingCard', 'upcomingCol'),
        column('upcomingCol', ['upcomingTitle', 'rfi036', 'rfi037']),
        text('upcomingTitle', '### Upcoming (2)'),
        text(
          'rfi036',
          '**RFI-036** Kitchen island outlet location. Bridger Electric, due 2026-11-25',
        ),
        text(
          'rfi037',
          '**RFI-037** Exterior stone veneer return depth. Madison Masonry, due 2026-11-30',
        ),
        card('closedCard', 'closedCol'),
        column('closedCol', ['closedTitle', 'rfi029']),
        text('closedTitle', '### Closed (1)'),
        text(
          'rfi029',
          '**RFI-029** Basement egress window well size. Summit Framing, due 2026-11-14, answered 2026-11-13, closed',
        ),
      ]),
    ],
    markdown: [
      '## RFI triage: Aspen Hollow Lot 12',
      '',
      'As of 2026-11-23',
      '',
      '### Overdue (2)',
      '',
      '- **RFI-031** Header size at garage door opening. Summit Framing, due 2026-11-18',
      '- **RFI-034** Shower niche waterproofing detail. Gallatin Tile Co., due 2026-11-20',
      '',
      '### Upcoming (2)',
      '',
      '- **RFI-036** Kitchen island outlet location. Bridger Electric, due 2026-11-25',
      '- **RFI-037** Exterior stone veneer return depth. Madison Masonry, due 2026-11-30',
      '',
      '### Closed (1)',
      '',
      '- **RFI-029** Basement egress window well size. Summit Framing, due 2026-11-14, answered 2026-11-13, closed',
      '',
    ].join('\n'),
  },
};

// ---------------------------------------------------------------------------
// 2. Ridgeline daily project brief
// ---------------------------------------------------------------------------

const briefFixture = {
  asOfDate: AS_OF_DATE,
  project: PROJECT,
  scheduleTasks: [
    {
      id: 'TSK-0582',
      name: 'Roof sheathing',
      phase: 'framing',
      status: 'in_progress',
      startDate: '2026-11-17',
      endDate: '2026-11-24',
      tradeName: 'Summit Framing',
    },
    {
      id: 'TSK-0587',
      name: 'Window install',
      phase: 'framing',
      status: 'delayed',
      startDate: '2026-11-19',
      endDate: '2026-11-26',
      tradeName: 'Gallatin Glass',
      notes: 'Two units back-ordered until 2026-12-02.',
    },
    {
      id: 'TSK-0590',
      name: 'Rough plumbing',
      phase: 'rough_in',
      status: 'not_started',
      startDate: '2026-11-30',
      endDate: '2026-12-08',
      tradeName: 'Hyalite Plumbing',
    },
  ],
  latestDailyLog: {
    id: 'DL-1193',
    logDate: '2026-11-22',
    weather: 'snow',
    tempHighF: 28,
    tempLowF: 14,
    crewCount: 9,
    weatherDelayHours: 2,
    workPerformed: 'Sheathed south roof plane; set ridge beam blocking.',
  },
  openRfiCount: 4,
  overdueRfiCount: 2,
  openPunchCount: 3,
  changeOrders: [
    {
      id: 'CO-007',
      title: 'Upgrade to triple-pane great room windows',
      status: 'pending_approval',
      amountCents: 385000,
      scheduleImpactDays: 4,
    },
  ],
};

const projectBrief: Scenario = {
  id: 'project-brief',
  title: 'Daily project brief',
  product: 'Ridgeline',
  description:
    'A one-screen morning dashboard: schedule risk, yesterday’s log, open items, and pending change orders.',
  prompt:
    'Build the morning brief for Aspen Hollow Lot 12 for 2026-11-23. Include project status and target completion, schedule tasks that are in progress or delayed, the latest daily log, open and overdue RFI counts, open punch count, and pending change orders with amounts.',
  fixture: briefFixture,
  facts: {
    project: 'Aspen Hollow Lot 12',
    projectId: 'PRJ-2417',
    briefDate: '2026-11-23',
    targetCompletion: '2027-04-16',
    inProgressTask: 'Roof sheathing',
    delayedTask: 'Window install',
    delayReason: 'back-ordered until 2026-12-02',
    latestLogDate: '2026-11-22',
    crewCount: '9',
    changeOrderId: 'CO-007',
    changeOrderAmount: '$3,850.00',
  },
  rubric: {
    id: 'ridgeline-project-brief-v1',
    task: 'Summarize the state of Aspen Hollow Lot 12 for the morning of 2026-11-23.',
    questions: {
      targetDate: 'Does the output state a target completion date of 2027-04-16?',
      delayedWindows: 'Does the output flag the Window install task as delayed?',
      roofInProgress: 'Does the output show the Roof sheathing task as in progress?',
      latestLog: 'Does the output reference the 2026-11-22 daily log with a crew count of 9?',
      overdueRfis: 'Does the output state that 2 RFIs are overdue?',
      changeOrder: 'Does the output list CO-007 as pending approval for $3,850.00?',
      noInventedTasks:
        'Does the output avoid naming any schedule task other than Roof sheathing, Window install, or Rough plumbing?',
    },
  },
  stub: {
    messages: [
      createSurface('project-brief', [
        column('root', ['heading', 'summary', 'statsRow', 'scheduleCard', 'logCard', 'coCard']),
        text('heading', '## Aspen Hollow Lot 12: brief for 2026-11-23'),
        text('summary', 'PRJ-2417, active. Target completion 2027-04-16.', 'caption'),
        row('statsRow', ['statRfis', 'statOverdue', 'statPunch']),
        text('statRfis', '**4** open RFIs'),
        text('statOverdue', '**2** overdue RFIs'),
        text('statPunch', '**3** open punch items'),
        card('scheduleCard', 'scheduleCol'),
        column('scheduleCol', ['scheduleTitle', 'taskRoof', 'taskWindows']),
        text('scheduleTitle', '### Schedule'),
        text('taskRoof', '**Roof sheathing**: in progress, ends 2026-11-24 (Summit Framing)'),
        text(
          'taskWindows',
          '**Window install**: delayed. Two units back-ordered until 2026-12-02 (Gallatin Glass)',
        ),
        card('logCard', 'logCol'),
        column('logCol', ['logTitle', 'logBody']),
        text('logTitle', '### Latest daily log: 2026-11-22'),
        text(
          'logBody',
          'Snow, 28°F / 14°F, 9 crew, 2 h weather delay. Sheathed south roof plane; set ridge beam blocking.',
        ),
        card('coCard', 'coCol'),
        column('coCol', ['coTitle', 'coItem']),
        text('coTitle', '### Pending change orders'),
        text(
          'coItem',
          '**CO-007** Upgrade to triple-pane great room windows: $3,850.00, +4 days, pending approval',
        ),
      ]),
    ],
    markdown: [
      '## Aspen Hollow Lot 12: brief for 2026-11-23',
      '',
      'PRJ-2417, active. Target completion 2027-04-16.',
      '',
      '- **4** open RFIs',
      '- **2** overdue RFIs',
      '- **3** open punch items',
      '',
      '### Schedule',
      '',
      '- **Roof sheathing**: in progress, ends 2026-11-24 (Summit Framing)',
      '- **Window install**: delayed. Two units back-ordered until 2026-12-02 (Gallatin Glass)',
      '',
      '### Latest daily log: 2026-11-22',
      '',
      'Snow, 28°F / 14°F, 9 crew, 2 h weather delay. Sheathed south roof plane; set ridge beam blocking.',
      '',
      '### Pending change orders',
      '',
      '- **CO-007** Upgrade to triple-pane great room windows: $3,850.00, +4 days, pending approval',
      '',
    ].join('\n'),
  },
};

// ---------------------------------------------------------------------------
// 3. Ridgeline editable punch item proposal
// ---------------------------------------------------------------------------

const punchFixture = {
  asOfDate: AS_OF_DATE,
  project: PROJECT,
  walkthroughNote: {
    id: 'WALK-0219',
    recordedAt: '2026-11-23T15:20:00Z',
    author: 'Dana Whitfield',
    text: 'Stair landing: nail pops in the drywall along the outside wall, about six of them. Needs to be fixed before paint on 2026-12-01.',
  },
  // Authoritative values for the draft. The model must show these verbatim rather than
  // deriving its own number, title, or location from the walkthrough note.
  proposedPunchItem: {
    id: 'PI-018',
    title: 'Drywall nail pops at stair landing',
    location: 'Stair landing, outside wall',
    neededBy: '2026-12-01',
    defaultPriority: 'medium',
  },
  existingPunchItems: [
    {
      id: 'PI-015',
      number: 15,
      title: 'Garage slab crack at north wall',
      status: 'open',
      dueDate: '2026-12-04',
    },
    {
      id: 'PI-016',
      number: 16,
      title: 'Missing hose bib escutcheon',
      status: 'ready_for_review',
      dueDate: '2026-11-26',
    },
    {
      id: 'PI-017',
      number: 17,
      title: 'Scratched primary bath window frame',
      status: 'open',
      dueDate: '2026-12-01',
    },
  ],
  priorityOptions: ['low', 'medium', 'high'],
};

const punchProposal: Scenario = {
  id: 'punch-proposal',
  title: 'Punch item proposal',
  product: 'Ridgeline',
  description:
    'Turn a walkthrough note into an editable punch item draft that the user reviews before submitting.',
  prompt:
    'From walkthrough note WALK-0219, propose a new punch item for Aspen Hollow Lot 12. Prefill an editable title, description, and priority (low, medium, or high), and let the user submit it with a Propose button. ' +
    'The fixture field proposedPunchItem is authoritative: in both the UI and the Markdown, show its id, title, location, and neededBy exactly as written, character for character, without paraphrasing. ' +
    'Prefill the title input with that exact title, start the description with that exact location, and preselect its defaultPriority. ' +
    'Nothing is saved until the user confirms, so never say the punch item was created or saved.',
  fixture: punchFixture,
  facts: {
    project: PROJECT.name,
    sourceNote: punchFixture.walkthroughNote.id,
    proposedNumber: punchFixture.proposedPunchItem.id,
    title: punchFixture.proposedPunchItem.title,
    location: punchFixture.proposedPunchItem.location,
    neededBy: punchFixture.proposedPunchItem.neededBy,
    priority: punchFixture.proposedPunchItem.defaultPriority,
  },
  rubric: {
    id: 'ridgeline-punch-proposal-v1',
    task: 'Propose an editable punch item for Aspen Hollow Lot 12 from walkthrough note WALK-0219.',
    questions: {
      titleEditable: 'Can the user edit the punch item title before submitting?',
      descriptionEditable: 'Can the user edit the punch item description before submitting?',
      prioritySelectable: 'Can the user choose the priority from low, medium, and high?',
      prefilledTitle: 'Is the proposed title about drywall nail pops at the stair landing?',
      neededBy: 'Does the output mention that the fix is needed before 2026-12-01?',
      submitControl: 'Is there a single control to submit the proposal for confirmation?',
      notSaved: 'Does the output avoid claiming that the punch item has already been created?',
    },
  },
  stub: {
    messages: [
      createSurface(
        'punch-proposal',
        [
          column('root', ['heading', 'source', 'formCard']),
          text('heading', '## Proposed punch item PI-018'),
          text(
            'source',
            'From walkthrough note WALK-0219 on Aspen Hollow Lot 12. Needed before paint on 2026-12-01.',
            'caption',
          ),
          card('formCard', 'formCol'),
          column('formCol', ['titleField', 'descriptionField', 'priorityPicker', 'proposeButton']),
          {
            id: 'titleField',
            component: 'TextField',
            label: 'Title',
            value: {'@path': '/punch/title'},
            variant: 'shortText',
          },
          {
            id: 'descriptionField',
            component: 'TextField',
            label: 'Description',
            value: {'@path': '/punch/description'},
            variant: 'longText',
          },
          {
            id: 'priorityPicker',
            component: 'ChoicePicker',
            label: 'Priority',
            variant: 'mutuallyExclusive',
            displayStyle: 'chips',
            options: [
              {label: 'Low', value: 'low'},
              {label: 'Medium', value: 'medium'},
              {label: 'High', value: 'high'},
            ],
            value: {'@path': '/punch/priority'},
          },
          {
            id: 'proposeButton',
            component: 'Button',
            variant: 'primary',
            child: 'proposeLabel',
            action: {
              event: {
                name: 'proposePunch',
                context: {
                  title: {'@path': '/punch/title'},
                  description: {'@path': '/punch/description'},
                  priority: {'@path': '/punch/priority'},
                },
              },
            },
          },
          text('proposeLabel', 'Propose punch item'),
        ],
        {
          punch: {
            title: 'Drywall nail pops at stair landing',
            description:
              'Stair landing, outside wall: about six drywall nail pops. Reset and patch before paint on 2026-12-01.',
            priority: ['medium'],
          },
        },
      ),
    ],
    markdown: [
      '## Proposed punch item PI-018',
      '',
      'From walkthrough note WALK-0219 on Aspen Hollow Lot 12. Needed before paint on 2026-12-01.',
      '',
      '- **Title:** Drywall nail pops at stair landing',
      '- **Description:** Stair landing, outside wall: about six drywall nail pops. Reset and patch before paint on 2026-12-01.',
      '- **Priority:** medium (options: low, medium, high)',
      '',
      'Edit the fields above, then choose **Propose punch item**. Nothing is saved until you confirm.',
      '',
    ].join('\n'),
  },
};

// ---------------------------------------------------------------------------
// 4. Ridgeline mobile daily log draft
// ---------------------------------------------------------------------------

const dailyLogFixture = {
  asOfDate: AS_OF_DATE,
  project: PROJECT,
  author: {id: 'USR-0042', name: 'Dana Whitfield', role: 'superintendent'},
  todaySignals: {
    weather: 'snow',
    tempHighF: 26,
    tempLowF: 11,
    crewOnSite: 7,
    voiceMemo:
      'Finished north roof sheathing. Snow stopped work for about an hour after lunch. Gallatin Glass confirmed two windows arrive 2026-12-02.',
  },
  previousLog: {id: 'DL-1193', logDate: '2026-11-22', crewCount: 9},
};

const dailyLog: Scenario = {
  id: 'daily-log',
  title: 'Daily log draft (mobile)',
  product: 'Ridgeline',
  description:
    'A phone-width form that drafts today’s daily log from a voice memo, with editable date and notes.',
  prompt:
    'On a phone screen, draft today’s daily log for Aspen Hollow Lot 12 from the superintendent’s voice memo. Show weather and crew count, prefill an editable log date and notes, and offer a Draft button. Keep it to one narrow column.',
  fixture: dailyLogFixture,
  facts: {
    project: 'Aspen Hollow Lot 12',
    logDate: '2026-11-23',
    weather: 'Snow',
    crewCount: '7',
    windowDelivery: '2026-12-02',
    weatherDelay: 'about an hour',
  },
  rubric: {
    id: 'ridgeline-daily-log-v1',
    task: 'Draft the 2026-11-23 daily log for Aspen Hollow Lot 12 in a phone-width layout.',
    questions: {
      dateEditable: 'Can the user edit the log date before drafting?',
      notesEditable: 'Can the user edit the log notes before drafting?',
      dateValue: 'Is the log date prefilled as 2026-11-23?',
      crew: 'Does the output state a crew count of 7?',
      weatherDelay: 'Do the notes mention that snow stopped work for about an hour?',
      windowDelivery: 'Do the notes mention the window delivery on 2026-12-02?',
      singleColumn: 'Is the layout a single column with no side-by-side panels?',
    },
  },
  stub: {
    messages: [
      createSurface(
        'daily-log',
        [
          column('root', ['heading', 'conditions', 'logDateField', 'notesField', 'draftButton']),
          text('heading', '## Daily log: Aspen Hollow Lot 12'),
          text('conditions', 'Snow, 26°F / 11°F, 7 crew on site', 'caption'),
          {
            id: 'logDateField',
            component: 'DateTimeInput',
            label: 'Log date',
            value: {'@path': '/log/logDate'},
            enableDate: true,
          },
          {
            id: 'notesField',
            component: 'TextField',
            label: 'Notes',
            value: {'@path': '/log/notes'},
            variant: 'longText',
          },
          {
            id: 'draftButton',
            component: 'Button',
            variant: 'primary',
            child: 'draftLabel',
            action: {
              event: {
                name: 'draftDailyLog',
                context: {
                  logDate: {'@path': '/log/logDate'},
                  notes: {'@path': '/log/notes'},
                },
              },
            },
          },
          text('draftLabel', 'Draft daily log'),
        ],
        {
          log: {
            logDate: '2026-11-23',
            notes:
              'Finished north roof sheathing. Snow stopped work for about an hour after lunch. Gallatin Glass confirmed two windows arrive 2026-12-02.',
          },
        },
      ),
    ],
    markdown: [
      '## Daily log: Aspen Hollow Lot 12',
      '',
      'Snow, 26°F / 11°F, 7 crew on site',
      '',
      '- **Log date:** 2026-11-23',
      '- **Notes:** Finished north roof sheathing. Snow stopped work for about an hour after lunch. Gallatin Glass confirmed two windows arrive 2026-12-02.',
      '',
      'Edit the date or notes, then choose **Draft daily log**.',
      '',
    ].join('\n'),
  },
  mobile: true,
};

// ---------------------------------------------------------------------------
// 5. Cortex decision card with citations
// ---------------------------------------------------------------------------

const decisionFixture = {
  question: 'What did we decide about where tenant audit logs are stored?',
  decision: {
    id: 'DEC-118',
    statement: 'Store tenant audit logs in a separate per-tenant Postgres schema.',
    rationale:
      'Keeps tenant data isolated for export and deletion requests without running a second database.',
    decider: 'Rowan Ellery',
    date: '2026-11-12',
    status: 'accepted',
    supersedes: 'DEC-097',
  },
  sources: [
    {
      id: 'SRC-ADR-0042',
      title: 'ADR-0042: Audit log storage',
      locator: '§3 Decision',
      excerpt: 'Each tenant gets its own audit schema; the shared events table is retired.',
    },
    {
      id: 'SRC-MTG-1112',
      title: 'Architecture review notes, 2026-11-12',
      locator: 'item 2',
      excerpt: 'Rowan approved per-tenant schemas; revisit if tenant count passes 5,000.',
    },
    {
      id: 'SRC-TKT-3381',
      title: 'Ticket PLAT-3381',
      locator: 'description',
      excerpt: 'Deletion requests currently take two days because of the shared events table.',
    },
  ],
  unrelatedSources: [
    {
      id: 'SRC-ADR-0039',
      title: 'ADR-0039: Session token lifetime',
      locator: '§2',
      excerpt: 'Access tokens expire after 15 minutes.',
    },
  ],
};

const decisionCard: Scenario = {
  id: 'decision-card',
  title: 'Decision card with citations',
  product: 'Cortex',
  description:
    'Answer a “what did we decide” question with one decision card and its supporting citations.',
  prompt:
    'Answer: what did we decide about where tenant audit logs are stored? Show the decision, who decided it and when, the rationale, what it supersedes, and cite each supporting source by its ID and locator. Do not cite unrelated sources.',
  fixture: decisionFixture,
  facts: {
    decisionId: 'DEC-118',
    statement: 'Store tenant audit logs in a separate per-tenant Postgres schema.',
    decider: 'Rowan Ellery',
    date: '2026-11-12',
    supersedes: 'DEC-097',
    citation1: 'SRC-ADR-0042',
    citation2: 'SRC-MTG-1112',
    citation3: 'SRC-TKT-3381',
    revisitThreshold: '5,000',
  },
  rubric: {
    id: 'cortex-decision-card-v1',
    task: 'Answer what was decided about tenant audit log storage, with citations.',
    questions: {
      statesDecision:
        'Does the output state that tenant audit logs are stored in a per-tenant Postgres schema?',
      decider: 'Does the output name Rowan Ellery as the decider?',
      date: 'Does the output date the decision 2026-11-12?',
      supersedes: 'Does the output say the decision supersedes DEC-097?',
      citesAdr: 'Does the output cite SRC-ADR-0042?',
      citesMeeting: 'Does the output cite SRC-MTG-1112?',
      noUnrelated: 'Does the output avoid citing SRC-ADR-0039?',
      noUnsupported: 'Is every claim in the output supported by one of the cited sources?',
    },
  },
  stub: {
    messages: [
      createSurface('decision-card', [
        column('root', ['question', 'decisionCard', 'sourcesCard']),
        text('question', 'What did we decide about where tenant audit logs are stored?', 'caption'),
        card('decisionCard', 'decisionCol'),
        column('decisionCol', ['decisionHeading', 'statement', 'meta', 'rationale']),
        text('decisionHeading', '### DEC-118 (accepted, supersedes DEC-097)'),
        text('statement', '**Store tenant audit logs in a separate per-tenant Postgres schema.**'),
        text('meta', 'Decided by Rowan Ellery on 2026-11-12 [SRC-MTG-1112]', 'caption'),
        text(
          'rationale',
          'Keeps tenant data isolated for export and deletion requests without running a second database [SRC-ADR-0042, SRC-TKT-3381]. Revisit if tenant count passes 5,000 [SRC-MTG-1112].',
        ),
        card('sourcesCard', 'sourcesCol'),
        column('sourcesCol', ['sourcesTitle', 'src1', 'divider1', 'src2', 'divider2', 'src3']),
        text('sourcesTitle', '### Sources'),
        text('src1', '**SRC-ADR-0042** ADR-0042: Audit log storage, §3 Decision'),
        divider('divider1'),
        text('src2', '**SRC-MTG-1112** Architecture review notes, 2026-11-12, item 2'),
        divider('divider2'),
        text('src3', '**SRC-TKT-3381** Ticket PLAT-3381, description'),
      ]),
    ],
    markdown: [
      'What did we decide about where tenant audit logs are stored?',
      '',
      '### DEC-118 (accepted, supersedes DEC-097)',
      '',
      '**Store tenant audit logs in a separate per-tenant Postgres schema.**',
      '',
      'Decided by Rowan Ellery on 2026-11-12 [SRC-MTG-1112]',
      '',
      'Keeps tenant data isolated for export and deletion requests without running a second database [SRC-ADR-0042, SRC-TKT-3381]. Revisit if tenant count passes 5,000 [SRC-MTG-1112].',
      '',
      '### Sources',
      '',
      '- **SRC-ADR-0042** ADR-0042: Audit log storage, §3 Decision',
      '- **SRC-MTG-1112** Architecture review notes, 2026-11-12, item 2',
      '- **SRC-TKT-3381** Ticket PLAT-3381, description',
      '',
    ].join('\n'),
  },
};

// ---------------------------------------------------------------------------
// 6. LocalFlow meeting action items
// ---------------------------------------------------------------------------

const meetingFixture = {
  meeting: {
    id: 'MTG-0457',
    title: 'Weekly site coordination',
    date: '2026-11-20',
    attendees: ['Dana Whitfield', 'Marcus Oyelaran', 'Lena Brandt', 'Theo Castellanos'],
  },
  transcript: [
    {
      speaker: 'Dana Whitfield',
      text: 'Marcus, can you get the revised window delivery confirmation in writing by Tuesday the 24th?',
    },
    {speaker: 'Marcus Oyelaran', text: 'Yes, I will send it to the group by 2026-11-24.'},
    {
      speaker: 'Lena Brandt',
      text: 'I will answer the shower niche RFI, RFI-034, by Wednesday 2026-11-25.',
    },
    {
      speaker: 'Dana Whitfield',
      text: 'Theo, please book the framing inspection for the week of 2026-12-01. Let us say booked by 2026-11-26.',
    },
    {
      speaker: 'Theo Castellanos',
      text: 'Will do. Also, someone should look at the stone veneer question eventually.',
    },
    {speaker: 'Dana Whitfield', text: 'Let us leave the stone veneer for next week; no owner yet.'},
  ],
  userNotes: '## Actions\n- windows\n- niche RFI\n- inspection',
};

const meetingActions: Scenario = {
  id: 'meeting-actions',
  title: 'Meeting action items',
  product: 'LocalFlow',
  description: 'Pull owner-and-due-date action items out of a recorded coordination meeting.',
  prompt:
    'From the 2026-11-20 weekly site coordination transcript, list the action items. Give each one an owner and a due date taken from the transcript. List anything mentioned without an owner separately as unassigned.',
  fixture: meetingFixture,
  facts: {
    meetingId: 'MTG-0457',
    meetingDate: '2026-11-20',
    action1Owner: 'Marcus Oyelaran',
    action1Due: '2026-11-24',
    action2Owner: 'Lena Brandt',
    action2Due: '2026-11-25',
    action2Rfi: 'RFI-034',
    action3Owner: 'Theo Castellanos',
    action3Due: '2026-11-26',
    unassigned: 'stone veneer',
  },
  rubric: {
    id: 'localflow-meeting-actions-v1',
    task: 'Extract action items with owners and due dates from the 2026-11-20 weekly site coordination meeting.',
    questions: {
      windowsAction:
        'Does the output assign the window delivery confirmation to Marcus Oyelaran, due 2026-11-24?',
      rfiAction: 'Does the output assign answering RFI-034 to Lena Brandt, due 2026-11-25?',
      inspectionAction:
        'Does the output assign booking the framing inspection to Theo Castellanos, due 2026-11-26?',
      everyOwner:
        'Does every assigned action item in the output have both an owner and a due date?',
      unassigned:
        'Does the output list the stone veneer question as unassigned rather than giving it an owner?',
      noInvented:
        'Does the output avoid any action item, owner, or due date that is not in the transcript?',
    },
  },
  stub: {
    messages: [
      createSurface('meeting-actions', [
        column('root', ['heading', 'meta', 'actionsCard', 'unassignedCard']),
        text('heading', '## Weekly site coordination: action items'),
        text('meta', 'MTG-0457, 2026-11-20', 'caption'),
        card('actionsCard', 'actionsCol'),
        column('actionsCol', ['action1', 'action2', 'action3']),
        row('action1', ['action1Task', 'action1Who']),
        text('action1Task', 'Send written window delivery confirmation'),
        text('action1Who', 'Marcus Oyelaran, due 2026-11-24', 'caption'),
        row('action2', ['action2Task', 'action2Who']),
        text('action2Task', 'Answer shower niche RFI-034'),
        text('action2Who', 'Lena Brandt, due 2026-11-25', 'caption'),
        row('action3', ['action3Task', 'action3Who']),
        text('action3Task', 'Book framing inspection for the week of 2026-12-01'),
        text('action3Who', 'Theo Castellanos, due 2026-11-26', 'caption'),
        card('unassignedCard', 'unassignedCol'),
        column('unassignedCol', ['unassignedTitle', 'unassignedItem']),
        text('unassignedTitle', '### Unassigned'),
        text(
          'unassignedItem',
          'Review the stone veneer question (deferred to next week, no owner)',
        ),
      ]),
    ],
    markdown: [
      '## Weekly site coordination: action items',
      '',
      'MTG-0457, 2026-11-20',
      '',
      '| Action | Owner | Due |',
      '| --- | --- | --- |',
      '| Send written window delivery confirmation | Marcus Oyelaran | 2026-11-24 |',
      '| Answer shower niche RFI-034 | Lena Brandt | 2026-11-25 |',
      '| Book framing inspection for the week of 2026-12-01 | Theo Castellanos | 2026-11-26 |',
      '',
      '### Unassigned',
      '',
      '- Review the stone veneer question (deferred to next week, no owner)',
      '',
    ].join('\n'),
  },
};

// Rubrics are frozen so evaluation questions cannot drift at runtime. The rest of each
// scenario stays mutable-by-type but should be treated as read-only by callers.
for (const scenario of [
  rfiTriage,
  projectBrief,
  punchProposal,
  dailyLog,
  decisionCard,
  meetingActions,
]) {
  deepFreeze(scenario.rubric);
}

export const scenarios: Scenario[] = [
  rfiTriage,
  projectBrief,
  punchProposal,
  dailyLog,
  decisionCard,
  meetingActions,
];

export function findScenario(id: string): Scenario | undefined {
  return scenarios.find(scenario => scenario.id === id);
}
