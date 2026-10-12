import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from postgrest.exceptions import APIError
from supabase import Client

from app.core.security import get_current_department_head
from app.core.supabase import get_supabase
from app.schemas import (
    EnrollmentConfigurationResponse,
    EnrollmentConfigurationUpdate,
)

router = APIRouter(prefix="/enrollment-config", tags=["Enrollment Configuration"])
logger = logging.getLogger(__name__)
MASTER_SETTINGS_ID = 1


def _get_master_settings(db: Client) -> dict:
    try:
        result = (
            db.table("system_settings")
            .select("*")
            .eq("id", MASTER_SETTINGS_ID)
            .execute()
        )
    except APIError as error:
        logger.exception("Could not read the enrollment configuration")
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Enrollment settings are unavailable; verify the system_settings table and master row in Supabase",
        ) from error
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Enrollment settings are not initialized; insert the master system settings row in Supabase",
        )
    return result.data[0]


@router.get(
    "/current",
    response_model=EnrollmentConfigurationResponse,
    summary="Get the active enrollment configuration",
)
def get_enrollment_configuration(
    _: dict = Depends(get_current_department_head),
    db: Client = Depends(get_supabase),
):
    """Return the active term and enrollment dates to the department head."""
    return _get_master_settings(db)


@router.put(
    "/current",
    response_model=EnrollmentConfigurationResponse,
    summary="Update the active enrollment configuration",
)
def update_enrollment_configuration(
    payload: EnrollmentConfigurationUpdate,
    request: Request,
    current_department_head: dict = Depends(get_current_department_head),
    db: Client = Depends(get_supabase),
):
    """Update the active term and enrollment window; department head only."""
    updated_data = {
        **payload.model_dump(mode="json"),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        result = (
            db.table("system_settings")
            .update(updated_data)
            .eq("id", MASTER_SETTINGS_ID)
            .execute()
        )
    except APIError as error:
        logger.exception("Could not update the enrollment configuration")
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The enrollment configuration could not be saved",
        ) from error

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Enrollment settings are not initialized; insert the master system settings row in Supabase",
        )

    updated = result.data[0]
    db.table("audit_log").insert(
        {
            "faculty_id": current_department_head["id"],
            "action": (
                "Updated enrollment configuration "
                f"({updated['active_school_year']}, semester {updated['active_semester']}, "
                f"{updated['enrollment_start']} to {updated['enrollment_end']})"
            ),
            "ip_address": request.client.host if request.client else None,
        }
    ).execute()
    return updated
