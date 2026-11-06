"""SEC financials reuse source licensing, UUID and archive transaction boundaries."""

from .sec_company_service import CompanyProfiles
from .sec_financial_protocol import PURPOSE, SOURCE, FinancialTarget, code, directory_entry, project


class FinancialStatements(CompanyProfiles):
    source_version = SOURCE
    purpose = PURPOSE
    target_type = FinancialTarget
    receipt_table = 'sec_financial_receipts'
    page_table = 'sec_financial_pages'
    document_kind = 'companyfacts'
    capture_scope = 'companyfacts_us_gaap_last_8_observed_periods'

    def normalize_code(self, value):
        return code(value)

    def known_entry(self, symbol):
        # Original financials always resolves the actual complete SEC directory.
        return None

    def directory_entry(self, raw, symbol):
        return directory_entry(raw, symbol)

    def project_document(self, raw, entry, symbol):
        return project(raw, entry, symbol)
