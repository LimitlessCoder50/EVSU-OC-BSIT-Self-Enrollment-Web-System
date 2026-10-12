from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, status
from supabase import Client

from app.core.supabase import get_supabase
from app.core.security import get_current_user
from app.schemas import AuditLogResponse

router = APIRouter(prefix="/audit-logs", tags=["Audit Logs"])


def _get_audit_user(current_user: dict = Depends(get_current_user)) -> dict:
    """Allow admins to review system activity and department heads their own."""
    account = current_user["account"]
    if current_user["account_type"] == "faculty" and account.get("role") != "department_head":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Department head privileges are required to view audit logs",
        )
    return current_user


def _add_actor_names(logs: list[dict], db: Client) -> list[dict]:
    admin_ids = {log["admin_id"] for log in logs if log.get("admin_id") is not None}
    faculty_ids = {log["faculty_id"] for log in logs if log.get("faculty_id") is not None}
    names: dict[tuple[str, int], str] = {}

    for table, ids, actor_type in (
        ("admin", admin_ids, "admin"),
        ("faculty", faculty_ids, "faculty"),
    ):
        if not ids:
            continue
        result = (
            db.table(table)
            .select("id,fname,mname,lname,email")
            .in_("id", list(ids))
            .execute()
        )
        for actor in result.data:
            name = " ".join(
                part for part in (
                    actor.get("fname"),
                    actor.get("mname"),
                    actor.get("lname"),
                ) if part
            ).strip()
            names[(actor_type, actor["id"])] = name or actor.get("email") or "Unknown actor"

    for log in logs:
        actor_type = "faculty" if log.get("faculty_id") is not None else "admin"
        actor_id = log.get("faculty_id") if actor_type == "faculty" else log.get("admin_id")
        log["actor_name"] = names.get((actor_type, actor_id), "Unknown actor")
    return logs


# ---------------------------------------------------------------------------
# GET /audit-logs  — list audit logs
# ---------------------------------------------------------------------------

@router.get(
    "/",
    response_model=List[AuditLogResponse],
    summary="List audit logs",
)
def list_audit_logs(
    admin_id: Optional[int] = Query(None, description="Filter by admin ID"),
    action: Optional[str] = Query(None, description="Filter by action type"),
    limit: int = Query(50, ge=1, le=500, description="Max records to return"),
    offset: int = Query(0, ge=0, description="Number of records to skip"),
    current_user: dict = Depends(_get_audit_user),
    db: Client = Depends(get_supabase),
):
    """Return system logs to admins and own logs to the department head."""
    query = db.table("audit_log").select("*").order("created_at", desc=True)

    if current_user["account_type"] == "faculty":
        query = query.eq("faculty_id", current_user["account"]["id"])
    elif admin_id is not None:
        query = query.eq("admin_id", admin_id)
    if action is not None:
        query = query.eq("action", action)

    query = query.range(offset, offset + limit - 1)
    result = query.execute()

    return _add_actor_names(result.data, db)


# ---------------------------------------------------------------------------
# GET /audit-logs/{log_id}  — get a single log entry
# ---------------------------------------------------------------------------

@router.get(
    "/{log_id}",
    response_model=AuditLogResponse,
    summary="Get a single audit log entry",
)
def get_audit_log(
    log_id: int,
    current_user: dict = Depends(_get_audit_user),
    db: Client = Depends(get_supabase),
):
    """Return a log entry, enforcing department-head ownership."""
    result = db.table("audit_log").select("*").eq("id", log_id).execute()

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Audit log entry not found",
        )

    log = result.data[0]
    if (
        current_user["account_type"] == "faculty"
        and log.get("faculty_id") != current_user["account"]["id"]
    ):
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Audit log entry not found",
        )
    return _add_actor_names([log], db)[0]
