#!/bin/bash
# Double-click to start Motus-Touch (Mac). Keep the Terminal window open while editing.
cd "$(dirname "$0")" && exec python3 serve.py chrome
