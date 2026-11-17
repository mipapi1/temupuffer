"""temupuffer search: a hybrid search app over arXiv abstracts.

It talks to its database only through `backends.SearchBackend`, so the same app
runs on temupuffer or on real turbopuffer (BACKEND=temupuffer|turbopuffer).
"""
