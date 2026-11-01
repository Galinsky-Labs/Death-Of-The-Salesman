# Agent detail evidence boundary

DOTS-024 adds a compact roster preview and an expanded profile drawer for pointer, keyboard and touch users. The preview and drawer show current task, strategy, canonical timestamps, verified event results and recorded integer-minor spend.

The client accepts at most 50 bounded evidence events per visible agent and filters out events that are not explicitly verified. Malformed or future-dated evidence, unordered timestamps, fractional/negative spend and invalid currency fail closed. Synthetic preview data remains labeled by the surrounding workspace and records zero spend; it is not proof of a live worker or business outcome.

Hover and focus reveal the compact preview on larger viewports. Activating the roster tile opens the viewport-bound drawer; Escape, the close control and backdrop close it, and focus returns to the originating tile. The mobile route uses the same activation control without requiring hover.
