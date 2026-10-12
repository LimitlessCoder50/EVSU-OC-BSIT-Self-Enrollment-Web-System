from fastapi import APIRouter, Depends, HTTPException, Request, status
from postgrest.exceptions import APIError
from supabase import Client

from app.core.security import get_current_department_head, get_current_user
from app.core.supabase import get_supabase
from app.schemas import MessageResponse, SectionCreate, SectionResponse, SectionUpdate
from app.routes.class_schedules import _check_room_conflict, _time_value

router = APIRouter(prefix="/sections", tags=["Sections"])


@router.get(
    "/",
    response_model=list[SectionResponse],
    summary="List student sections",
)
def list_sections(
    current_user: dict = Depends(get_current_user),
    db: Client = Depends(get_supabase),
):
    """List student sections for authenticated accounts."""
    return (
        db.table("sections")
        .select("*")
        .order("year_level")
        .order("semester")
        .order("section_name")
        .execute()
        .data
    )


@router.post(
    "/",
    response_model=SectionResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Create a student section",
)
def create_section(
    payload: SectionCreate,
    request: Request,
    current_department_head: dict = Depends(get_current_department_head),
    db: Client = Depends(get_supabase),
):
    """Create a student section; only the department head may do this."""
    try:
        result = db.table("sections").insert(payload.model_dump()).execute()
    except APIError as error:
        if error.code == "23505":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A section with this name already exists",
            ) from error
        raise

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create section",
        )

    created = result.data[0]
    db.table("audit_log").insert(
        {
            "faculty_id": current_department_head["id"],
            "action": f"Created section ({created['section_name']})",
            "ip_address": request.client.host if request.client else None,
        }
    ).execute()
    return created


@router.patch(
    "/{public_id}",
    response_model=SectionResponse,
    summary="Update a student section",
)
def update_section(
    public_id: str,
    payload: SectionUpdate,
    request: Request,
    current_department_head: dict = Depends(get_current_department_head),
    db: Client = Depends(get_supabase),
):
    """Update a student section; only the department head may do this."""
    update_data = payload.model_dump(exclude_unset=True)
    if not update_data:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No fields to update",
        )

    if "semester" in update_data:
        current = (
            db.table("sections")
            .select("id,semester")
            .eq("public_id", public_id)
            .execute()
            .data
        )
        if not current:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Section not found",
            )
        section_id = current[0]["id"]
        if update_data["semester"] != current[0]["semester"]:
            schedules = (
                db.table("class_schedule")
                .select("id,section_id,room,days,start_time,end_time")
                .eq("section_id", section_id)
                .execute()
                .data
            )
            for schedule in schedules:
                _check_room_conflict(
                    db,
                    {
                        **schedule,
                        "start_time": _time_value(schedule["start_time"]),
                        "end_time": _time_value(schedule["end_time"]),
                    },
                    update_data["semester"],
                    exclude_schedule_id=schedule["id"],
                    semester_overrides={section_id: update_data["semester"]},
                )

    try:
        result = (
            db.table("sections")
            .update(update_data)
            .eq("public_id", public_id)
            .execute()
        )
    except APIError as error:
        if error.code == "23505":
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A section with this name already exists",
            ) from error
        raise

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Section not found",
        )

    updated = result.data[0]
    db.table("audit_log").insert(
        {
            "faculty_id": current_department_head["id"],
            "action": f"Updated section ({updated['section_name']})",
            "ip_address": request.client.host if request.client else None,
        }
    ).execute()
    return updated


@router.delete(
    "/{public_id}",
    response_model=MessageResponse,
    summary="Delete a student section",
)
def delete_section(
    public_id: str,
    request: Request,
    current_department_head: dict = Depends(get_current_department_head),
    db: Client = Depends(get_supabase),
):
    """Delete a student section and its cascading schedules."""
    existing = (
        db.table("sections")
        .select("id,section_name")
        .eq("public_id", public_id)
        .execute()
        .data
    )
    if not existing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Section not found",
        )

    db.table("sections").delete().eq("public_id", public_id).execute()
    db.table("audit_log").insert(
        {
            "faculty_id": current_department_head["id"],
            "action": f"Deleted section ({existing[0]['section_name']}) and its schedules",
            "ip_address": request.client.host if request.client else None,
        }
    ).execute()
    return MessageResponse(message="Section and its class schedules deleted successfully")
