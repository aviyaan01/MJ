import os
from pathlib import Path


def build_mj_full_prompt(user_command: str, master_prompt: str, jsonl_path: str = "jedi_training_data.jsonl") -> str:
    """
    Step 3: Jedi Dataset dynamic few-shot prompt builder.
    Combines Master Prompt + Jedi Dataset Reference Examples + Current User Command.
    """
    examples = []
    target_path = jsonl_path
    if not os.path.exists(target_path):
        base_cand = Path(__file__).resolve().parent.parent / jsonl_path
        if base_cand.exists():
            target_path = str(base_cand)

    try:
        with open(target_path, "r", encoding="utf-8") as f:
            for i in range(3):
                line = f.readline()
                if line:
                    examples.append(line.strip())
    except FileNotFoundError:
        pass

    dataset_context = "\n".join(examples)

    # Master Prompt + Jedi Dataset Reference + User Command ekshathe jora dewa
    final_prompt = f"""{master_prompt}

### REFERENCE OS INTERACTION EXAMPLES (FROM JEDI DATASET):
{dataset_context}

### CURRENT USER COMMAND:
"{user_command}"

Respond with your step-by-step plan and execute the required tool calls:"""

    return final_prompt
