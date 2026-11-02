import type { RawInputRow, RtaAdapter, TargetCompany } from "../types.js";

export const BLUE_CHIP_COMPANIES: TargetCompany[] = [
  {
    name: "Reliance Industries Limited",
    cin: "L17110MH1973PLC019786",
    isin: "INE002A01018",
    nseSymbol: "RELIANCE",
    bseCode: "500325",
    rta: "KFINTECH",
    iepfRegistryUrl: "https://www.ril.com/investors/shareholders-information/unclaimed-dividend",
  },
  {
    name: "ITC Limited",
    cin: "L16005WB1910PLC001981",
    isin: "INE154A01025",
    nseSymbol: "ITC",
    bseCode: "500875",
    rta: "IN_HOUSE",
    iepfRegistryUrl: "https://www.itcportal.com/investor-relations/unclaimed-dividend.aspx",
  },
  {
    name: "Larsen & Toubro Limited",
    cin: "L99999MH1946PLC004768",
    isin: "INE018A01030",
    nseSymbol: "LT",
    bseCode: "500510",
    rta: "KFINTECH",
    iepfRegistryUrl: "https://www.larsentoubro.com/investors/shareholder-services/unclaimed-dividend/",
  },
  {
    name: "State Bank of India",
    cin: "U99999MH1955PTC042970",
    isin: "INE062A01020",
    nseSymbol: "SBIN",
    bseCode: "500112",
    rta: "OTHER",
    iepfRegistryUrl: "https://sbi.co.in/web/investor-relations/unclaimed-dividend",
  },
  {
    name: "ICICI Bank Limited",
    cin: "L65190GJ1994PLC021012",
    isin: "INE090A01021",
    nseSymbol: "ICICIBANK",
    bseCode: "532174",
    rta: "OTHER",
    iepfRegistryUrl: "https://www.icicibank.com/about-us/investor-relations/unclaimed-dividend",
  },
  {
    name: "HDFC Bank Limited",
    cin: "L65920MH1994PLC080618",
    isin: "INE040A01034",
    nseSymbol: "HDFCBANK",
    bseCode: "500180",
    rta: "OTHER",
    iepfRegistryUrl: "https://www.hdfcbank.com/personal/resources/investor-relations/unclaimed-dividends",
  },
  {
    name: "Bharti Airtel Limited",
    cin: "L74899HR1995PLC095967",
    isin: "INE397D01024",
    nseSymbol: "BHARTIARTL",
    bseCode: "532454",
    rta: "KFINTECH",
    iepfRegistryUrl: "https://www.airtel.in/about-bharti/equity/unclaimed-dividend",
  },
  {
    name: "NTPC Limited",
    cin: "L40101DL1975GOI007966",
    isin: "INE733E01010",
    nseSymbol: "NTPC",
    bseCode: "532555",
    rta: "OTHER",
    iepfRegistryUrl: "https://www.ntpc.co.in/investors/unclaimed-dividend",
  },
  {
    name: "Oil and Natural Gas Corporation Limited",
    cin: "L74899DL1993GOI054155",
    isin: "INE213A01029",
    nseSymbol: "ONGC",
    bseCode: "500312",
    rta: "OTHER",
    iepfRegistryUrl: "https://ongcindia.com/web/eng/investors/unclaimed-dividend",
  },
  {
    name: "Power Grid Corporation of India Limited",
    cin: "L40101DL1989GOI038121",
    isin: "INE752E01010",
    nseSymbol: "POWERGRID",
    bseCode: "532898",
    rta: "OTHER",
    iepfRegistryUrl: "https://www.powergrid.in/unclaimed-dividend",
  },
  {
    name: "Coal India Limited",
    cin: "L23109WB1973GOI028844",
    isin: "INE522F01014",
    nseSymbol: "COALINDIA",
    bseCode: "533278",
    rta: "OTHER",
    iepfRegistryUrl: "https://www.coalindia.in/investors/unclaimed-dividend/",
  },
  {
    name: "Bharat Petroleum Corporation Limited",
    cin: "L23220MH1952GOI008931",
    isin: "INE029A01011",
    nseSymbol: "BPCL",
    bseCode: "500547",
    rta: "OTHER",
    iepfRegistryUrl: "https://www.bharatpetroleum.in/investor-relations/unclaimed-dividend.aspx",
  },
];

const BLUE_CHIP_NAMES = [
  "Brij Mohan Mittal", "Kalyan Sundaram", "Anand Swaroop Agarwal", "Sarala Devi Singhania",
  "Govind Ballabh Pant", "Kamala Ramanathan", "Hariprasad Chaurasia", "Lata Ranganathan",
  "Satyanarayana Raju", "Shailendra Kumar Saxena", "Jayantilal Mistry", "Indira Priyadarshini",
  "Pramod Mahajan", "Srinivasan Ramanujan", "Narasimha Rao", "Chandrashekhar Azad",
  "Prabhakar Deshpande", "Bimla Devi", "Mahendra Prasad", "Savita Srivastava"
];

const METRO_LOCATIONS = [
  { city: "Mumbai", state: "Maharashtra", pin: "400021" },
  { city: "New Delhi", state: "Delhi", pin: "110020" },
  { city: "Bengaluru", state: "Karnataka", pin: "560025" },
  { city: "Chennai", state: "Tamil Nadu", pin: "600004" },
  { city: "Kolkata", state: "West Bengal", pin: "700019" },
  { city: "Lucknow", state: "Uttar Pradesh", pin: "226001" },
  { city: "Chandigarh", state: "Chandigarh", pin: "160017" },
  { city: "Hyderabad", state: "Telangana", pin: "500034" },
];

export class BlueChipsAdapter implements RtaAdapter {
  readonly id = "blue_chips";
  readonly displayName = "BSE 500 / NSE Blue Chips Registry";
  readonly rtaType = "OTHER" as const;

  async discover(options?: { limit?: number; companyQuery?: string }): Promise<TargetCompany[]> {
    let list = [...BLUE_CHIP_COMPANIES];
    if (options?.companyQuery) {
      const q = options.companyQuery.toLowerCase();
      list = list.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          c.cin?.toLowerCase().includes(q) ||
          c.nseSymbol?.toLowerCase().includes(q),
      );
    }
    if (options?.limit && options.limit > 0) {
      list = list.slice(0, options.limit);
    }
    return list;
  }

  getSampleFiles(): Array<{
    company: TargetCompany;
    filePath?: string;
    generateRows?: (count: number) => RawInputRow[];
  }> {
    return BLUE_CHIP_COMPANIES.map((company) => ({
      company,
      generateRows: (count: number) => this.generateSampleRows(company, count),
    }));
  }

  /**
   * Generates synthetic Blue Chip IEPF-2 rows matching standard MCA Form IEPF-2 published formats
   */
  generateSampleRows(company: TargetCompany, count: number): RawInputRow[] {
    const rows: RawInputRow[] = [];
    const prefix = company.nseSymbol ? company.nseSymbol.slice(0, 4) : "BC";

    for (let i = 1; i <= count; i++) {
      const fullName = BLUE_CHIP_NAMES[i % BLUE_CHIP_NAMES.length]!;
      const parts = fullName.split(" ");
      const firstName = parts[0]!;
      const lastName = parts.length > 1 ? parts[parts.length - 1]! : "";
      const middleName = parts.length > 2 ? parts.slice(1, -1).join(" ") : "";
      const loc = METRO_LOCATIONS[i % METRO_LOCATIONS.length]!;
      const folio = `${prefix}${String(300000 + i).padStart(8, "0")}`;
      const amount = (500.0 + (i * 62.5) % 15000).toFixed(2);
      const shares = (25 + (i * 10) % 500);

      rows.push({
        "Investor First Name": firstName,
        "Investor Middle Name": middleName,
        "Investor Last Name": lastName,
        "Father Name": `${firstName} Senior`,
        "Folio Number": folio,
        "Amount Transferred": amount,
        "Proposed Date of Transfer": `2024-09-${String((i % 28) + 1).padStart(2, "0")}`,
        "State": loc.state,
        "City": loc.city,
        "Pincode": loc.pin,
        "Address": `Plot ${i % 100}, Sector ${i % 20}, Corporate Boulevard`,
        "Number of Shares": String(shares),
      });
    }

    return rows;
  }
}
