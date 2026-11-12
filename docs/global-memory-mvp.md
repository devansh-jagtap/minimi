# Global memory MVP ownership

Minimi currently has no authentication or account system. The MVP assigns all
requests to the stable server-side owner key `MINIMI_LOCAL_USER_ID`, defaulting
to `local-single-user`. The browser does not send an owner ID, and API calls
cannot choose another owner's memory. Existing conversation and research rows
are migrated to this owner without deleting messages.

This supports a single-user local installation only. The owner key is not
authentication and must not be used to separate people on a public or shared
multi-user deployment. Add a real authentication provider, derive ownership
from its verified server-side session, and migrate local records before enabling
multi-user production access.

Cross-conversation message search is bounded by a date window when the user
names a date and searches a small number of relevant terms. Other memory is
stored as deduplicated discussion records and queried by indexed owner/type/time
fields plus bounded keyword matching. Research sessions are retrieved by owner
and retain their observation/source links. No vector database is required for
this initial local implementation.
