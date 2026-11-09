/**
 * Kalshi's rules text, given to the AI so it knows how contracts are defined and settled.
 * Source: the "COMMODITIES" contract rules template PDF the owner supplied (Kalshi). Transcribed from its four pages of
 * contract terms. The PDF's "Appendix B (CONFIDENTIAL) – Trading Prohibitions" is deliberately NOT included: it is about who
 * may not trade, it is marked confidential, and the AI does not need it.
 */

export const KALSHI_RULES_NOTE =
  "This is Kalshi's general rules TEMPLATE for commodity contracts. Items in <angle brackets> (commodity, source agency, price type, value, " +
  "above/below/between/exactly/at least, in/at, time period, currency, unit) are filled in separately for each specific market. This document does NOT say " +
  "which of those apply to the 15-minute gold, silver or crypto contracts. If asked about a specific 15-minute market (which price, which source, whether it is " +
  "an 'in' or an 'at' contract, what the reference level is), say that those specifics are on that market's own rules page and are not in this document. " +
  "Do not guess them.";

export const KALSHI_COMMODITY_RULES = `COMMODITIES
Scope: These rules shall apply to this contract.

Underlying: The Underlying for this Contract is the <price type> price of <commodity> as published by <source agency> <in/at> <time period>. The Underlying is denominated in <currency> per <unit>. Revisions, corrections, or adjustments to the Underlying made after Expiration will not be accounted for in determining the Expiration Value.

Source Agency: The Source Agency is <source agency>. <source agency> refers to a commodity pricing data provider specified by the Exchange. This may include, for example, ICE Data Services or TradingView. If the specified <source agency> permanently ceases to publish the relevant <price type> for <commodity>, Kalshi shall designate an alternative Source Agency from the foregoing list that publishes a comparable price, at its sole discretion. If no comparable price is available from any listed Source Agency, Kalshi has the right to determine payouts pursuant to Rule 7.1 in the Rulebook.

Type: The type of Contract is an Event Contract.

Issuance: The Contract is based on the outcome of a recurrent data release, which is issued on a daily basis. Contract iterations will be issued on a recurring basis, and future Contract iterations will generally correspond to the next <time period>.

<commodity>: <commodity> refers to a physical commodity or commodity futures contract specified by the Exchange. It may include, but is not limited to, gold, silver, platinum, palladium, copper, crude oil (WTI or Brent), natural gas, heating oil, gasoline, wheat, corn, soybeans, coffee, sugar, cocoa, cotton, or any other commodity for which the specified <source agency> publishes pricing data. <commodity> shall be identified by its standard exchange ticker symbol or recognized industry name as used by the <source agency>. If <commodity> refers to a futures contract, the specific contract month (e.g., "front-month," "March 2026," or "nearest active") shall be specified by the Exchange (including, if specified, resolving based on the next available month if the target date is within, e.g., two days of the futures contract's Last Trading Date). The Exchange may list iterations of the Contract corresponding to variations of <commodity>.

<source agency>: <source agency> refers to the specific commodity pricing data provider designated by the Exchange from the list specified in the Source Agency section above. It may also refer to multiple Source Agencies. The Exchange may list iterations of the Contract corresponding to variations of <source agency>.

<price type>: <price type> refers to the specific category of price data used to resolve the Contract, as specified by the Exchange. <price type> may include, but is not limited to: (a) "settlement price" - the official daily settlement or closing price as determined by the specified <source agency>'s standard methodology; (b) "opening price" - the official opening price or first trade price of the trading session as published by the <source agency>; (c) "closing price" - the official closing price or last trade price of the trading session as published by the <source agency>; (d) "high price" - the highest traded price during the specified trading session; (e) "low price" - the lowest traded price during the specified trading session; (f) "last trade price" - the price of the most recent trade executed at or before the specified <time period>; (g) "spot price" - the price for immediate delivery as published by the <source agency> at the specified <time period>; (h) "fix price" - a benchmark price determined through a fixing process (e.g., LBMA Gold Fix, LBMA Silver Fix); (i) "TWAP" (time-weighted average price) - the arithmetic average of prices sampled at regular intervals over a specified period, as calculated and published by the <source agency>; or (j) "VWAP" (volume-weighted average price) - the average price weighted by trading volume over a specified period, as calculated and published by the <source agency>. The calculation methodology, sampling intervals, and constituent data for TWAP and VWAP shall be as defined by the <source agency>'s published methodology. If the <source agency> does not publish a TWAP or VWAP and the Exchange specifies one of these as the <price type>, the Exchange shall publish the calculation methodology and data source when the Contract is listed. The Exchange may list iterations of the Contract corresponding to variations of <price type>.

<value>: <value> refers to a numerical price level specified by the Exchange, denominated in <currency> per <unit>. Due to the potential for variability in the Underlying, the Exchange may modify <value> levels at any time and in response to suggestions by Members. <value> may also take the form of a percentage change relative to a given reference price at a given date and time.

<above/below/between/exactly/at least>: Refers to comparison operators as specified by the Exchange. "Above X" means strictly greater than X (>X). "Below X" means strictly less than X (<X). "Exactly X" means equal to X (=X), measured to the precision specified elsewhere in the Contract. "At least X" means greater than or equal to X (>=X). "Between X and Y" means greater than or equal to X and less than or equal to Y (>=X and <=Y), i.e., inclusive of both endpoints, unless otherwise specified. Where the Underlying value is rounded or reported to a specific number of decimal places, the comparison shall be applied to the value as reported by the Source Agency. The Exchange may specify rounding or truncation, including the applicable extent and number of decimal places, at Issuance. The Exchange may list iterations of the Contract corresponding to variations of <above/below/between/exactly/at least>.

<currency>: <currency> refers to the denomination of the commodity price, specified by the Exchange. Unless otherwise specified, this is U.S. dollars (USD). The Exchange may specify other currencies (e.g., EUR, GBP, JPY) as appropriate to the <source agency> and <commodity>.

<unit>: <unit> refers to the standard unit of measurement for the commodity price, as specified by the Exchange. Examples include troy ounce (for gold, silver, platinum, palladium), barrel (for crude oil), MMBtu (for natural gas), bushel (for wheat, corn, soybeans), pound (for coffee, sugar, cotton, copper), or metric ton (for base metals on the LME). <unit> shall conform to the standard unit used by the specified <source agency> for the specified <commodity> unless otherwise specified.

<time period>: <time period> refers to a specific duration, range of time, or discrete date and time specified by the Exchange. <time period> may be expressed as, but is not limited to expression as, a calendar year (e.g., "2025"), a calendar month and year (e.g., "January 2025"), a calendar quarter (e.g., "Q1 2025"), a specific week, a single trading day (e.g., "the trading session of February 17, 2026"), or other time period as appropriate to the contract subject matter, including a discrete date and time. All time periods are interpreted in Eastern Time (ET) unless otherwise specified. Unless otherwise specified, the end of <time period> is defined as 11:59:59 PM ET on the final day of the specified period. The Exchange may list iterations of the Contract corresponding to variations of <time period>. It may also refer to a specific time in addition to dates, e.g., a specific clock time (e.g., "1:30 PM ET"), the official open or close of a trading session as defined by the <source agency>, or a fixing time as defined by the <source agency>.

<in/at>: <in/at> refers to whether the Contracts will be determined on the basis of whether a given threshold is hit or maintained within <time period> (<in>) or at a certain discrete time in <time period> (e.g. 5pm on the 27th of September) (<at>).

Payout Criterion: The Payout Criterion for the Contract encompasses the Expiration Values where the <price type> price of <commodity>, as published by the <source agency>, is <above/below/between/exactly/at least> <value> (denominated in <currency> per <unit>) <in/at> <time period>.

Additional clarification(s):
- If no data is published by the <source agency> at the specified <time period> on a given day within <time period> for any reason, and is not anticipated to be published (or not published) within a week, then the most recently available data will be used to resolve the market.
- For Contracts specifying "above," "below," or "at least," and "in" (in conjunction), it shall be sufficient that the Expiration Value crosses or meets the specified threshold at any point during the relevant <time period>. One such crossing (in the case of above/below) or meeting (in the case of at least) shall validate the Contract condition for settlement.
- In the case of "exactly" and "at" (in conjunction), the Expiration Value must match the specified <value> "at" <time period> to the level of precision specified by the Exchange.
- For Contracts specifying "between" and "in" (in conjunction), the Exchange may additionally specify at Issuance whether the Expiration Value is required to remain continuously within the specified range throughout the entire <time period>, or whether it is sufficient for it to appear within the specified range at any point within <time period>. If the former is specified, any instance of the price moving outside the range during the <time period> shall cause the Contract to resolve to "No".
- If the <source agency> publishes a price that it subsequently identifies as erroneous due to a system fault, data feed malfunction, or technical error, and issues a formal correction within twenty-four (24) hours of the original publication, the corrected price shall be used to determine the Expiration Value. If no formal correction is issued by the <source agency> within 24 hours of the original publication, the originally published price shall be considered final for purposes of this Contract. If the <source agency> publicly acknowledges a system fault that caused a delay in publication within 24-hours but ultimately publishes the relevant <price type> price within the one-week period following <time period>, that delayed publication shall be used, if not already corrected by that point in time. If no publication occurs within that one-week period, the most recently available data prior to the fault shall be used.

Minimum Tick: The Minimum Tick size for the Contract shall be $0.01.

Position Accountability Level: The Position Accountability Level for the Contract shall be $25,000 per strike, per Member.

Last Trading Date: The latest Last Trading Date and Time of the Contract will be the end of <time period>.

Settlement Date: The Settlement Date of the Contract shall be no later than the day after the Expiration Date, unless the Market Outcome is under review pursuant to Rule 7.1.

Expiration Date: The latest Expiration Date of the Contract shall be one week after the end of <time period>. If an event described in the Payout Criterion occurs, expiration will be moved to an earlier date and time in accordance with Rule 7.2.

Expiration time: The Expiration time of the Contract shall be 10:00 AM ET.

Settlement Value: The Settlement Value for this Contract is $1.00.

Expiration Value: The Expiration Value is the value of the Underlying as documented by the Source Agency on the Expiration Date at the Expiration time.

Contingencies: Before Settlement, Kalshi may, at its sole discretion, initiate the Market Outcome Review Process pursuant to Rule 7.1 of the Rulebook. If an Expiration Value cannot be determined on the Expiration Date, Kalshi has the right to determine payouts pursuant to Rule 7.1 in the Rulebook.`;

/** The block placed in the AI's prompt. */
export const KALSHI_RULES_PROMPT = `KALSHI CONTRACT RULES (reference only)\n${KALSHI_RULES_NOTE}\n\n${KALSHI_COMMODITY_RULES}`;
