"""The committed legacy list parses, and marks exactly what the owner accepted."""
from wt.risk.mandate import LEGACY_FILE, legacy_positions, out_of_mandate


def test_the_committed_legacy_list_is_aapl_x1():
    assert legacy_positions(LEGACY_FILE) == {"AAPL": 1}


def test_aapl_x1_is_legacy_but_any_other_quantity_is_flagged_again():
    legacy = legacy_positions(LEGACY_FILE)
    assert out_of_mandate([("AAPL", 1), ("QQQM", 2)], {"QQQM"}, legacy) == [("AAPL", 1, True)]
    assert out_of_mandate([("AAPL", 2)], {"QQQM"}, legacy) == [("AAPL", 2, False)]
    assert out_of_mandate([("MSFT", 1)], {"QQQM"}, legacy) == [("MSFT", 1, False)]
