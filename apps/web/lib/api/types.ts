import type {
  CorporateActionType,
  CrmStage,
  CustodyStatus,
  DocStatus,
  DocType,
  EsignStatus,
  IndianState,
  IngestionStatus,
  LedgerEntryType,
  Profession,
  Role,
  RtaName,
  ScenarioType,
  TrackStatus,
} from "@finsol/shared";

/** Response shapes of the Finsol Enterprises API, as the web app reads them. */

export interface Stats {
  /** Holder records (statement entries): not people, not unique folios. */
  folios: number;
  holderRecords?: number;
  distinctFolios?: number;
  companiesWithRecords?: number;
  companies: number;
  companyProfiles?: number;
  listedEquities?: number;
  states: number;
  /** Published holder records: the headline figure. */
  verifiedRecords?: number;
  /** Shares with the IEPF, due for transfer or in suspense (once per folio) + listed amounts. */
  recoverableValuePaise?: number;
  shareValuePaise?: number;
  unclaimedAmountsPaise?: number;
  shareFolios?: number;
  estimatedValuePaise: number;
  activeCases: number;
  creditedCases: number;
  verifiedAssociates: number;
  asOf: string;
}

export interface CompanyListItem {
  slug: string;
  name: string;
  sector: string | null;
  tickerNse: string | null;
  currentMarketPrice: number | null;
  priceUpdatedAt: string | null;
  folioCount: number;
  updatedAt: string | null;
}

export interface CompanyAction {
  actionType: CorporateActionType;
  exDate: string;
  ratioFrom: number | null;
  ratioTo: number | null;
  dividendPerShare: number | null;
  notes: string | null;
  source: string | null;
}

/** The public company page. Contacts and identifiers are in AdminCompany (staff only). */
export interface CompanyDetail {
  slug: string;
  name: string;
  sector: string | null;
  tickerNse: string | null;
  tickerBse: string | null;
  /** Last synced market price (rupees); null until the first sync. */
  currentMarketPrice: number | null;
  priceUpdatedAt: string | null;
  priceQuoteAt?: string | null;
  priceAttemptedAt?: string | null;
  priceError?: string | null;
  priceSource: string | null;
  corporateActions: CompanyAction[];
  records: {
    custodyStatus: CustodyStatus;
    folios: number;
    shares: number;
    dividendRupees: number;
  }[];
}

/** The internal company file, for the case team. */
export interface AdminCompany {
  slug: string;
  name: string;
  cin: string | null;
  statutoryBasis: string | null;
  isin: string | null;
  sector: string | null;
  tickerNse: string | null;
  tickerBse: string | null;
  rta: {
    name: RtaName;
    label: string;
    address: string | null;
    email: string | null;
    phone: string | null;
    website: string | null;
  };
  nodalOfficer: {
    name: string;
    emails: string[];
    phone: string | null;
    address: string | null;
    deputies: { name: string; email: string | null }[];
  };
  contacts: { source: string | null; verifiedAt: string | null };
  irPageUrl: string | null;
  records: CompanyDetail["records"];
}

export interface AdminCompanyListItem {
  slug: string;
  name: string;
  cin: string | null;
  isin: string | null;
  rtaLabel: string;
  nodalOfficerName: string;
  nodalOfficerEmail: string | null;
}

export interface Me {
  id: string;
  name: string;
  role: Role;
  phone: string;
  email: string | null;
  associate: { id: string; referralCode: string; isVerified: boolean } | null;
}

export interface CaseSummary {
  caseCode: string;
  clientName: string;
  companyName: string;
  companySlug: string;
  scenarioType: ScenarioType;
  scenarioLabel: string;
  recoverStep: number;
  recoverStepName: string;
  esignStatus: EsignStatus;
  createdAt: string;
  updatedAt: string;
}

export interface VaultItem {
  docType: DocType;
  label: string;
  reason: string;
  beforeFiling: boolean;
  status: DocStatus;
  fileName: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  reviewerComment: string | null;
  uploadedAt: string | null;
  reviewedAt: string | null;
  hasFile: boolean;
}

export interface CaseDetail extends CaseSummary {
  viewerRole: "staff" | "client" | "associate";
  client: { name: string; phone: string | null };
  associate: { firmName: string; name: string } | null;
  company: {
    name: string;
    slug: string;
    /** Registrar, nodal officer and identifiers: staff only, null for everyone else. */
    internal: {
      rtaLabel: string;
      rtaAddress: string | null;
      rtaEmail: string | null;
      rtaPhone: string | null;
      nodalOfficerName: string | null;
      nodalOfficerEmail: string | null;
      nodalOfficerPhone: string | null;
      cin: string | null;
      isin: string | null;
    } | null;
  };
  holding: {
    holderName: string;
    /** Masked for clients until their analyst releases it. */
    folioNumber: string;
    folioReleased: boolean;
    certificateNumbers: string | null;
    originalShares: number;
    postActionShares: number;
    unclaimedDividendPaise: number;
    custodyStatus: CustodyStatus;
    custodyLabel: string;
    transferFinancialYear: string | null;
  } | null;
  /** The public 4-step service, which every viewer sees. */
  serviceStep: 1 | 2 | 3 | 4;
  serviceSteps: {
    step: number;
    title: string;
    body: string;
    state: "done" | "current" | "upcoming";
  }[];
  /** The internal R.E.C.O.V.E.R. steps: staff only, empty for everyone else. */
  steps: {
    step: number;
    key: string;
    letter: string;
    name: string;
    summary: string;
    owner: Role;
    state: "done" | "current" | "upcoming";
  }[];
  tracking: {
    holdingConfirmation: TrackStatus;
    claimFiled: boolean;
    companyVerification: TrackStatus;
    dematCredit: TrackStatus;
  };
  internal: {
    rtaEntitlementStatus: TrackStatus;
    mcaIepf5Srn: string | null;
    nodalVerificationStatus: TrackStatus;
    dematCreditStatus: TrackStatus;
  } | null;
  folioReleasedAt: string | null;
  esign: {
    status: EsignStatus;
    signedAt: string | null;
    provider: string;
    /** Only "aadhaar-esign" is a provider-verified Aadhaar signature. */
    method: "aadhaar-esign" | "portal-acceptance" | "development-simulator";
    requested: boolean;
    hasMandate: boolean;
  };
  money: {
    /** Custom pricing: null until the case team sets this case's fee. */
    feePct: number | null;
    basis: "credited" | "estimate";
    grossPaise: number;
    realization: {
      grossPaise: number;
      feeBps: number;
      feePaise: number;
      gstPaise: number;
      netPaise: number;
    } | null;
    sharePricePaise: number | null;
    priceUpdatedAt: string | null;
    priceSource: string | null;
  };
  timelineMonths: [number, number];
  vault: VaultItem[];
  vaultProgress: { required: number; verified: number; uploaded: number; rejected: number };
  events: {
    id: string;
    kind: string;
    message: string;
    actorName: string | null;
    createdAt: string;
  }[];
}

export interface LeadCard {
  type: "lead";
  id: string;
  claimantName: string;
  phone: string;
  phoneMasked: string;
  phoneVerified: boolean;
  relationship: string;
  certificates: string;
  estimatedValuePaise: number;
  holdings: {
    folioId: string;
    holder: string;
    company: string;
    shares: number;
    custody: string;
    folioReleased: boolean;
  }[];
  assignedAnalyst: { id: string; name: string } | null;
  associate: { firmName: string; referralCode: string } | null;
  notes: string | null;
  /** "DUPLICATE_CLAIMANT_REVIEW" when another client already claims one of these holdings. */
  reviewAlert: string | null;
  stage: CrmStage;
  unlockedAt: string | null;
  updatedAt: string;
}

export interface CaseCard {
  type: "case";
  id: string;
  caseCode: string;
  clientName: string;
  companyName: string;
  recoverStep: number;
  recoverStepName: string;
  esignStatus: EsignStatus;
  mcaIepf5Srn: string | null;
  feePct: number | null;
  folioReleased: boolean;
  rtaEntitlementStatus: TrackStatus;
  nodalVerificationStatus: TrackStatus;
  dematCreditStatus: TrackStatus;
  associate: { firmName: string } | null;
  updatedAt: string;
}

export interface BoardColumn {
  id: string;
  label: string;
  kind: "lead" | "case";
  items: (LeadCard | CaseCard)[];
}

export interface Board {
  columns: BoardColumn[];
}

export interface TeamMember {
  id: string;
  name: string;
  role: Role;
}

export interface LocatorEntry {
  id: string;
  name: string;
  firmName: string;
  profession: Profession;
  professionLabel: string;
  state: IndianState;
  stateLabel: string;
  city: string;
  bio: string | null;
  referralCode: string;
}

export interface AssociateDashboard {
  profile: {
    name: string;
    firmName: string;
    profession: Profession;
    professionLabel: string;
    state: IndianState;
    city: string;
    referralCode: string;
    revenueSharePct: number;
    isVerified: boolean;
    totalReferredCases: number;
  };
  totals: { accruedPaise: number; paidPaise: number; balancePaise: number };
  monthly: { month: string; accruedPaise: number; paidPaise: number }[];
  ledger: {
    id: string;
    entryType: LedgerEntryType;
    amountPaise: number;
    description: string;
    occurredAt: string;
    balancePaise: number;
  }[];
  leads: {
    id: string;
    claimantName: string;
    crmStage: CrmStage;
    phoneVerified: boolean;
    createdAt: string;
    estimatedValuePaise: number;
  }[];
  cases: {
    caseCode: string;
    clientName: string;
    companyName: string;
    recoverStep: number;
    dematCreditStatus: TrackStatus;
  }[];
}

export interface IngestionJob {
  id: string;
  formType: "IEPF_2" | "IEPF_4";
  fileName: string;
  sourceUrl: string | null;
  status: IngestionStatus;
  totalRows: number;
  insertedRows: number;
  updatedRows: number;
  skippedRows: number;
  warningRows?: number;
  quarantinedRows?: number;
  parserVersion?: string | null;
  sourceDocumentId?: string | null;
  retryOfId?: string | null;
  errors: { row: number; message: string }[];
  uploadedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** GET /admin/ingestion/coverage: aggregates only. */
export interface CoverageReport {
  asOf: string;
  listedEquities: number;
  companyProfiles: number;
  holderRecords: number;
  recordGroups: number;
  byValidation: { validation_status: string; review_status: string; records: number }[];
  companies: {
    name: string;
    slug: string;
    holderRecords: number;
    distinctFolios: number;
    recordGroups: number;
    byCustody: Record<string, number>;
    corporateActions: number;
    hasIrPage: boolean;
    price: number | null;
    priceSource: string | null;
    priceQuoteAt: string | null;
    priceRetrievedAt: string | null;
    priceAttemptedAt: string | null;
    priceError: string | null;
  }[];
  sources: {
    id: string;
    fileName: string;
    sourceUrl: string | null;
    documentType: string;
    reportingPeriod: string | null;
    publishedAt: string | null;
    publishedAtBasis: string;
    retrievedAt: string | null;
    sha256: string;
    parserVersion: string;
    status: string;
    reviewStatus: string;
    publicationStatus: string;
    validRows: number;
    warningRows: number;
    quarantinedRows: number;
  }[];
  jobs: { status: string; count: number; latestFinishedAt: string | null }[];
  sourceRows: { validationStatus: string; reviewStatus: string; rows: number }[];
}
