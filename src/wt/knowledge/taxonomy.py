"""K0 component taxonomy + lexicon (regexes) used for deterministic frequency mining.

The lexicon is intentionally explicit so counts are reproducible. LLM extraction
(K0.2) refines parameters; this module decides *how often* a concept appears.
"""
from __future__ import annotations

import re

COMPONENT_TYPES = [
    "selection.universe", "selection.catalyst", "selection.rvol", "selection.momentum",
    "selection.time", "setup", "entry.trigger", "stop", "target", "management", "exit",
    "risk.sizing", "risk.expectancy", "microstructure", "psychology", "mistake", "win_behaviour",
]

# concept -> (component_type, regex). Regexes run on lower-cased chunk text.
LEXICON: dict[str, tuple[str, str]] = {
    # selection
    "low_float": ("selection.universe", r"low[\s-]*float|float\s*(under|<|below|less than)|small\s+float|\bfloat\b[^.]{0,40}million"),
    "price_band": ("selection.universe", r"\$\s?\d{1,2}\s*(-|to|–)\s*\$?\s?\d{1,2}\b|price\s+(range|between)|penny\s+stock|small[\s-]*cap"),
    "above_key_ma": ("selection.universe", r"above\s+(the\s+)?(9|20|50|200)\s*(ema|sma|ma|day)|(200|50)\s*(ema|sma|day moving)"),
    "catalyst_news": ("selection.catalyst", r"catalyst|breaking\s+news|\bnews\b|press\s+release|\bfda\b|earnings\s+(beat|report)"),
    "relative_volume": ("selection.rvol", r"\brvol\b|relative\s+volume|\d+\s*x\s+(average\s+)?volume|volume\s+(spike|surge)"),
    "gap_up": ("selection.momentum", r"\bgap(ping|ped|s)?\s*(up|er|and|&|n)?\b|gap\s*%|pre[\s-]*market\s+(gainer|mover)"),
    "percent_up_day": ("selection.momentum", r"up\s+(at\s+least\s+)?\d{1,3}\s*%|\d{1,3}\s*%\s+(up|gain|on the day)|top\s+gainer"),
    "scanner": ("selection.momentum", r"scanner|\bscan(s|ning)?\b|watch\s*list"),
    "first_hours": ("selection.time", r"first\s+(1|one|2|two)[\s-]*(hour|hr)|first\s+(30|15|hour)|9:30|morning\s+(session|trad)|open(ing)?\s+bell|pre[\s-]*market"),
    # setups
    "bull_flag": ("setup", r"bull(ish)?\s*flag|flag\s+pattern"),
    "micro_pullback": ("setup", r"micro[\s-]*pull\s*back"),
    "flat_top_breakout": ("setup", r"flat[\s-]*top"),
    "abcd": ("setup", r"\babcd\b"),
    "gap_and_go": ("setup", r"gap\s*(and|&|n)\s*go"),
    "vwap_setup": ("setup", r"\bvwap\b"),
    "opening_range": ("setup", r"opening\s+range|\borb\b"),
    "red_to_green": ("setup", r"red[\s-]*to[\s-]*green"),
    "reversal": ("setup", r"reversal|double\s+bottom|bounce\s+off|hammer|dragonfly"),
    "pullback_generic": ("setup", r"pull\s*back"),
    "breakout_generic": ("setup", r"break\s*out|breaking\s+(out|above)"),
    "support_resistance": ("setup", r"support|resistance|supply\s*(and|&)\s*demand"),
    # entries
    "first_candle_new_high": ("entry.trigger", r"first\s+(1[\s-]*min(ute)?\s+|5[\s-]*min(ute)?\s+)?candle\s+(to\s+)?mak(e|ing)\s+(a\s+)?new\s+high"),
    "break_prior_high": ("entry.trigger", r"break(s|ing)?\s+(of\s+)?(the\s+)?(prior|previous|pre[\s-]*market|high\s+of\s+day)\s+high|new\s+high\s+of\s+day|\bhod\b"),
    "whole_half_dollar": ("entry.trigger", r"(whole|half)[\s-]*dollar|round\s+number|\.(00|50)\s+(level|break|mark|area)|break(s|ing)?\s+(of\s+)?(the\s+)?\$?\d+\.(00|50)\b"),
    "premarket_high_break": ("entry.trigger", r"pre[\s-]*market\s+high"),
    # stops
    "stop_candle_low": ("stop", r"low\s+of\s+(the\s+)?(prior|previous|last|pull\s*back|5[\s-]*min(ute)?|1[\s-]*min(ute)?)\s*(candle|bar)?|below\s+(the\s+)?(prior|previous)\s+candle"),
    "stop_generic": ("stop", r"stop[\s-]*loss|\bstop\b"),
    "stop_vwap": ("stop", r"(stop|exit)[^.]{0,40}(below|under)\s+(the\s+)?vwap"),
    # targets / management / exit
    "profit_target": ("target", r"profit\s+target|take\s+profit|price\s+target|target\s+(price|of)"),
    "partials_scale_out": ("management", r"scal(e|ing)\s+out|(take|taking|took)\s+(some\s+)?partials?|partial\s+profit|sell\s+(half|1/2|a\s+portion|some)"),
    "add_to_winner": ("management", r"add(ing)?\s+(on|to)\s+(the\s+)?(micro\s+)?(pull\s*back|position|winner)|scal(e|ing)\s+in"),
    "breakeven_stop": ("management", r"(stop|move)[^.]{0,30}break[\s-]*even"),
    "trailing_stop": ("management", r"trail(ing)?\s+stop|trailing\s+order"),
    "sell_into_strength": ("exit", r"sell(ing)?\s+(in)?to\s+strength|sell\s+(on|into)\s+(the\s+)?(spike|pop|squeeze)"),
    "macd_exit": ("exit", r"\bmacd\b"),
    "exit_failed": ("exit", r"(exit|get\s+out|cut)[^.]{0,40}(wasn.?t|not)\s+the\s+trade|failed\s+(break\s*out|setup)|bail"),
    # risk
    "position_sizing": ("risk.sizing", r"position\s+siz|share\s+size|how\s+many\s+shares|size\s+(up|down)"),
    "max_loss": ("risk.sizing", r"max(imum)?\s+(daily\s+)?loss|daily\s+(stop|loss\s+limit)|risk\s+(per|\d+%)|1\s*%\s+(of|risk)"),
    "risk_reward": ("risk.expectancy", r"risk\s*(to|/|:|-)?\s*reward|reward\s*(to|/|:|-)?\s*risk|\brrr\b|profit\s*(to|/)?\s*loss\s+ratio|\d\s*:\s*1\b"),
    "win_rate_expectancy": ("risk.expectancy", r"win\s*(rate|ratio|%)|accuracy|expectancy|profit\s+factor"),
    # microstructure
    "level2_tape": ("microstructure", r"level\s*(2|ii)\b|\btape\s+read|reading\s+the\s+tape|time\s*(and|&)\s*sales|order\s+book|market\s+depth|bid\s*(and|/|&|vs\.?)\s*ask|big\s+(seller|buyer|bid|ask)"),
    "halts": ("microstructure", r"\bhalt(ed|s)?\b|luld|circuit\s+breaker"),
    # psychology / behaviour
    "dont_chase": ("psychology", r"don.?t\s+chase|chasing|fomo"),
    "discipline": ("psychology", r"discipline|patience|emotion|revenge\s+trad|overtrad|respect\s+(your\s+)?stop"),
    "mistake": ("mistake", r"mistake|lesson\s+learn|should\s+have|shouldn.?t\s+have|👎|loss\s+because"),
    "win": ("win_behaviour", r"👍|green\s+day|winning\s+trade|what\s+worked"),
}

COMPILED = {k: (t, re.compile(rx)) for k, (t, rx) in LEXICON.items()}


def tag(text: str) -> set[str]:
    t = text.lower()
    return {k for k, (_, rx) in COMPILED.items() if rx.search(t)}
