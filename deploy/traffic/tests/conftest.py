import pytest

from harness_traffic.client import FineractClient
from harness_traffic.seed import SeedResult

BASE = "https://fineract.test"
API = BASE + "/fineract-provider/api/v1"


@pytest.fixture
def client():
    return FineractClient(BASE, "u", "p")


@pytest.fixture
def seed_result():
    return SeedResult(office_id=1, staff_id=2, loan_product_id=3, savings_product_id=4, payment_type_id=5, client_ids=[10, 11])
