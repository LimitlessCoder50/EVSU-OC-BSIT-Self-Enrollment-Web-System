from fastapi import APIRouter, Depends, HTTPException, Request, status
from postgrest.exceptions import APIError
from supabase import Client

from app.core.admin_accounts import create_admin_account
from app.core.supabase import get_supabase
from app.core.security import (
    hash_password,
    verify_password,
    create_access_token,
    get_current_admin,
    get_current_super_admin,
    get_current_faculty,
    get_current_student,
)
from app.schemas import (
    AdminCreate,
    AdminResponse,
    FacultyResponse,
    FacultyTokenResponse,
    StudentCreate,
    StudentResponse,
    StudentTokenResponse,
    LoginRequest,
    TokenResponse,
    ChangePasswordRequest,
    MessageResponse,
)

router = APIRouter(prefix="/auth", tags=["Authentication"])


def _log_audit(db: Client, admin_id: int, action: str, ip: str | None):
    """Helper to insert an audit log entry."""
    db.table("audit_log").insert(
        {"admin_id": admin_id, "action": action, "ip_address": ip}
    ).execute()


def _log_faculty_audit(db: Client, faculty_id: int, action: str, ip: str | None):
    db.table("audit_log").insert(
        {"faculty_id": faculty_id, "action": action, "ip_address": ip}
    ).execute()


def _student_token_response(student: dict) -> StudentTokenResponse:
    token = create_access_token(
        data={"sub": student["public_id"], "account_type": "student"}
    )
    return StudentTokenResponse(
        access_token=token,
        student=StudentResponse(**student),
    )


def _raise_student_conflict(error: APIError) -> None:
    if error.code == "23505":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="A student account already uses that email or ID number",
        ) from error
    raise error


# ---------------------------------------------------------------------------
# POST /auth/register
# ---------------------------------------------------------------------------

@router.post(
    "/register",
    response_model=AdminResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register a new admin",
)
def register(
    payload: AdminCreate,
    request: Request,
    current_admin: dict = Depends(get_current_super_admin),
    db: Client = Depends(get_supabase),
):
    """Create a new admin account; only super admins may register accounts."""
    return create_admin_account(
        payload,
        current_admin["id"],
        request.client.host if request.client else None,
        "REGISTER",
        db,
    )


# ---------------------------------------------------------------------------
# POST /auth/login
# ---------------------------------------------------------------------------

@router.post(
    "/login",
    response_model=TokenResponse,
    summary="Admin login",
)
def login(payload: LoginRequest, request: Request, db: Client = Depends(get_supabase)):
    """Authenticate an admin and return a JWT access token."""

    result = (
        db.table("admin")
        .select("*")
        .eq("email", payload.email)
        .eq("is_active", True)
        .execute()
    )

    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    admin = result.data[0]

    if not verify_password(payload.password, admin["hashed_password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    access_token = create_access_token(
        data={"sub": admin["public_id"], "account_type": "admin"}
    )

    # Audit log
    _log_audit(db, admin["id"], "LOGIN", request.client.host if request.client else None)

    return TokenResponse(
        access_token=access_token,
        admin=AdminResponse(**admin),
    )


@router.post(
    "/faculty-login",
    response_model=FacultyTokenResponse,
    summary="Faculty login",
)
def faculty_login(
    payload: LoginRequest,
    request: Request,
    db: Client = Depends(get_supabase),
):
    """Authenticate an active faculty member and return a JWT access token."""
    result = (
        db.table("faculty")
        .select("*")
        .eq("email", payload.email)
        .eq("is_active", True)
        .execute()
    )
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    faculty = result.data[0]
    if not verify_password(payload.password, faculty["hashed_password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )

    access_token = create_access_token(
        data={"sub": faculty["public_id"], "account_type": "faculty"}
    )
    _log_faculty_audit(
        db,
        faculty["id"],
        "LOGIN",
        request.client.host if request.client else None,
    )
    return FacultyTokenResponse(
        access_token=access_token,
        faculty=FacultyResponse(**faculty),
    )


@router.post(
    "/student-signup",
    response_model=StudentTokenResponse,
    status_code=status.HTTP_201_CREATED,
    summary="Register a student account",
)
def student_signup(
    payload: StudentCreate,
    db: Client = Depends(get_supabase),
):
    """Create a student account and return a student-scoped access token."""
    for field, value, label in (
        ("id_number", payload.id_number, "ID number"),
        ("email", str(payload.email), "Email"),
    ):
        existing = db.table("student").select("id").eq(field, value).execute()
        if existing.data:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"A student account already uses that {label.lower()}",
            )

    student_data = payload.model_dump(exclude={"password"})
    student_data["email"] = str(payload.email)
    student_data["hashed_password"] = hash_password(payload.password)
    try:
        result = db.table("student").insert(student_data).execute()
    except APIError as error:
        _raise_student_conflict(error)
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Failed to create student account",
        )
    return _student_token_response(result.data[0])


@router.post(
    "/student-login",
    response_model=StudentTokenResponse,
    summary="Student login",
)
def student_login(
    payload: LoginRequest,
    db: Client = Depends(get_supabase),
):
    """Authenticate an active student and return a student-scoped token."""
    result = (
        db.table("student")
        .select("*")
        .eq("email", payload.email)
        .eq("is_active", True)
        .execute()
    )
    if not result.data:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )
    student = result.data[0]
    if not verify_password(payload.password, student["hashed_password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid email or password",
        )
    return _student_token_response(student)


# ---------------------------------------------------------------------------
# GET /auth/me
# ---------------------------------------------------------------------------

@router.get(
    "/me",
    response_model=AdminResponse,
    summary="Get current admin profile",
)
def get_me(current_admin: dict = Depends(get_current_admin)):
    """Return the currently authenticated admin's profile."""
    return current_admin


@router.get(
    "/faculty/me",
    response_model=FacultyResponse,
    summary="Get current faculty profile",
)
def get_current_faculty_profile(
    current_faculty: dict = Depends(get_current_faculty),
):
    """Return the currently authenticated faculty member's profile."""
    return current_faculty


@router.get(
    "/student/me",
    response_model=StudentResponse,
    summary="Get current student profile",
)
def get_current_student_profile(
    current_student: dict = Depends(get_current_student),
):
    """Return the currently authenticated student's profile."""
    return current_student


# ---------------------------------------------------------------------------
# PUT /auth/change-password
# ---------------------------------------------------------------------------

@router.put(
    "/change-password",
    response_model=MessageResponse,
    summary="Change admin password",
)
def change_password(
    payload: ChangePasswordRequest,
    request: Request,
    current_admin: dict = Depends(get_current_admin),
    db: Client = Depends(get_supabase),
):
    """Change the current admin's password."""

    if not verify_password(payload.current_password, current_admin["hashed_password"]):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Current password is incorrect",
        )

    new_hash = hash_password(payload.new_password)
    db.table("admin").update({"hashed_password": new_hash}).eq("id", current_admin["id"]).execute()

    # Audit log
    _log_audit(
        db, current_admin["id"], "CHANGE_PASSWORD",
        request.client.host if request.client else None,
    )

    return MessageResponse(message="Password changed successfully")
